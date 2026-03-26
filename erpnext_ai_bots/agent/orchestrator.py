import frappe
import json
import time
import anthropic
from erpnext_ai_bots.tools.registry import ToolRegistry
from erpnext_ai_bots.agent.streaming import StreamBridge
from erpnext_ai_bots.agent.subagent import SubagentSpawner
from erpnext_ai_bots.agent.prompts import get_system_prompt
from erpnext_ai_bots.guards.permissions import PermissionGuard
from erpnext_ai_bots.tools.sanitizer import InputSanitizer
from erpnext_ai_bots.utils.token_counter import TokenTracker
from erpnext_ai_bots.utils.prompt_defense import check_prompt_injection
from erpnext_ai_bots.guards.cost_gate import CostGate


class Orchestrator:
    """Single agent that handles all user requests.
    Owns all tools. Streams responses. Spawns subagents only when needed.
    """

    def __init__(self, user: str, session_id: str, company: str = None):
        self.user = user
        self.session_id = session_id
        self.company = company or frappe.defaults.get_user_default("company", user)
        self.settings = frappe.get_cached_doc("AI Bot Settings")

        # Initialize components
        self.client = self._get_client()
        self.tool_registry = ToolRegistry(user=self.user, company=self.company)
        self.permission_guard = PermissionGuard(user=self.user)
        self.sanitizer = InputSanitizer()
        self.cost_gate = CostGate(user=self.user, company=self.company)
        self.token_tracker = TokenTracker(session_id=self.session_id)
        self.stream_bridge = StreamBridge(session_id=self.session_id, user=self.user)

        # Conversation state
        self.messages = self._load_messages()
        self.turn_tool_calls = 0

    def _get_client(self) -> anthropic.Anthropic:
        api_key = self.settings.get_password("api_key")
        return anthropic.Anthropic(api_key=api_key)

    def _load_messages(self) -> list:
        session = frappe.get_doc("AI Chat Session", self.session_id)
        if session.messages_json:
            return json.loads(session.messages_json)
        return []

    def _save_messages(self):
        frappe.db.set_value(
            "AI Chat Session",
            self.session_id,
            {
                "messages_json": json.dumps(self.messages, default=str),
                "message_count": len([m for m in self.messages if m["role"] == "user"
                                      and not isinstance(m.get("content"), list)]),
                "last_message_at": frappe.utils.now_datetime(),
                "total_input_tokens": self.token_tracker.total_input,
                "total_output_tokens": self.token_tracker.total_output,
                "total_cost_usd": self.token_tracker.total_cost,
                "total_tool_calls": self.turn_tool_calls,
            },
            update_modified=False,
        )
        frappe.db.commit()

    def handle_message(self, user_message: str):
        """Main entry point. Called from the API endpoint."""
        # 1. Prompt injection defense
        check_prompt_injection(user_message)

        # 2. Cost/license gate (commercial edition)
        self.cost_gate.check_quota()

        # 3. Append user message
        self.messages.append({
            "role": "user",
            "content": user_message,
            "timestamp": frappe.utils.now_datetime().isoformat(),
        })

        # 4. Agent loop
        self._agent_loop()

        # 5. Persist
        self._save_messages()

    def _agent_loop(self):
        """Core loop: call model, stream response, handle tool calls, repeat."""
        max_iterations = self.settings.max_tool_calls_per_turn or 15

        for _ in range(max_iterations):
            api_messages = self._prepare_messages_for_api()

            with self.client.messages.stream(
                model=self.settings.model_name or "claude-sonnet-4-20250514",
                max_tokens=self.settings.max_tokens_per_request or 4096,
                system=get_system_prompt(self.user, self.company),
                tools=self.tool_registry.get_all_schemas(),
                messages=api_messages,
            ) as stream:
                response = self.stream_bridge.process_stream(stream)

            # Track tokens
            self.token_tracker.record(
                input_tokens=response.usage.input_tokens,
                output_tokens=response.usage.output_tokens,
                cache_creation_tokens=getattr(
                    response.usage, "cache_creation_input_tokens", 0
                ),
                cache_read_tokens=getattr(
                    response.usage, "cache_read_input_tokens", 0
                ),
                model=self.settings.model_name,
            )

            # Append assistant response
            self.messages.append({
                "role": "assistant",
                "content": self._serialize_content_blocks(response.content),
                "timestamp": frappe.utils.now_datetime().isoformat(),
                "usage": {
                    "input_tokens": response.usage.input_tokens,
                    "output_tokens": response.usage.output_tokens,
                },
            })

            if response.stop_reason != "tool_use":
                self.stream_bridge.send_done()
                break

            # Process tool calls
            tool_results = self._process_tool_calls(response.content)
            self.messages.append({
                "role": "user",
                "content": tool_results,
                "timestamp": frappe.utils.now_datetime().isoformat(),
            })
        else:
            self.stream_bridge.send_error(
                "Maximum tool call limit reached. Please simplify your request."
            )

    def _prepare_messages_for_api(self) -> list:
        """Strip custom metadata keys before sending to Anthropic."""
        cleaned = []
        for msg in self.messages:
            cleaned.append({"role": msg["role"], "content": msg["content"]})

        # Context window management: cap at 100 messages
        if len(cleaned) > 100:
            cleaned = cleaned[:2] + cleaned[-98:]

        return cleaned

    def _serialize_content_blocks(self, content_blocks) -> list:
        """Convert Anthropic SDK content block objects to JSON-serializable dicts."""
        serialized = []
        for block in content_blocks:
            if block.type == "text":
                serialized.append({"type": "text", "text": block.text})
            elif block.type == "tool_use":
                serialized.append({
                    "type": "tool_use",
                    "id": block.id,
                    "name": block.name,
                    "input": block.input,
                })
        return serialized

    def _process_tool_calls(self, content_blocks) -> list:
        """Execute tool calls with permission checks, sanitization, and audit."""
        results = []

        for block in content_blocks:
            if block.type != "tool_use":
                continue

            self.turn_tool_calls += 1
            tool_name = block.name
            tool_input = block.input
            tool_id = block.id
            start_time = time.time()

            self.stream_bridge.send_tool_start(tool_name, tool_input)

            try:
                # Permission check
                self.permission_guard.check(tool_name, tool_input)

                # Input sanitization
                sanitized_input, blocked_fields = self.sanitizer.sanitize(
                    tool_name, tool_input
                )

                # Subagent spawn
                if tool_name == "meta.spawn_subagent":
                    result = self._handle_subagent(sanitized_input)
                else:
                    tool_fn = self.tool_registry.get_tool(tool_name)
                    result = tool_fn.execute(**sanitized_input)

                exec_time = int((time.time() - start_time) * 1000)

                self._audit_log(
                    tool_name=tool_name,
                    tool_input=sanitized_input,
                    tool_output=result,
                    status="Success",
                    exec_time=exec_time,
                    blocked_fields=blocked_fields,
                )

                self.stream_bridge.send_tool_result(tool_name, result)

                results.append({
                    "type": "tool_result",
                    "tool_use_id": tool_id,
                    "content": json.dumps(result, default=str),
                })

            except frappe.PermissionError as e:
                exec_time = int((time.time() - start_time) * 1000)
                self._audit_log(
                    tool_name=tool_name,
                    tool_input=tool_input,
                    tool_output={"error": str(e)},
                    status="PermissionDenied",
                    exec_time=exec_time,
                )
                results.append({
                    "type": "tool_result",
                    "tool_use_id": tool_id,
                    "content": json.dumps({"error": f"Permission denied: {e}"}),
                    "is_error": True,
                })

            except Exception as e:
                exec_time = int((time.time() - start_time) * 1000)
                self._audit_log(
                    tool_name=tool_name,
                    tool_input=tool_input,
                    tool_output={"error": str(e)},
                    status="Error",
                    exec_time=exec_time,
                )
                results.append({
                    "type": "tool_result",
                    "tool_use_id": tool_id,
                    "content": json.dumps({"error": str(e)}),
                    "is_error": True,
                })

        return results

    def _handle_subagent(self, params: dict) -> dict:
        if not self.settings.subagent_enabled:
            return {"error": "Subagent spawning is disabled"}

        spawner = SubagentSpawner(
            user=self.user,
            company=self.company,
            parent_session_id=self.session_id,
            token_tracker=self.token_tracker,
            stream_bridge=self.stream_bridge,
            max_depth=self.settings.max_subagent_depth or 2,
        )
        return spawner.run(
            task_description=params["task"],
            tools_needed=params.get("tools", []),
            context=params.get("context", ""),
        )

    def _audit_log(self, tool_name, tool_input, tool_output,
                   status, exec_time, blocked_fields=None):
        """Write an immutable audit log entry."""
        action_type = "Read"
        if "create" in tool_name:
            action_type = "Create"
        elif "update" in tool_name:
            action_type = "Update"
        elif "submit" in tool_name:
            action_type = "Submit"

        output_str = json.dumps(tool_output, default=str)
        if len(output_str) > 10000:
            output_str = output_str[:10000] + "... [truncated]"

        frappe.get_doc({
            "doctype": "AI Audit Log",
            "session": self.session_id,
            "user": self.user,
            "company": self.company,
            "tool_name": tool_name,
            "tool_input_json": json.dumps(tool_input, default=str),
            "tool_output_json": output_str,
            "tool_result_status": status,
            "execution_time_ms": exec_time,
            "doctype_accessed": tool_input.get("doctype", ""),
            "document_name": tool_input.get("name", ""),
            "action_type": action_type,
            "fields_requested": json.dumps(tool_input.get("fields", [])),
            "fields_blocked": json.dumps(blocked_fields or []),
        }).insert(ignore_permissions=True)
        frappe.db.commit()


def run_orchestrator(user: str, session_id: str, message: str, company: str):
    """Entry point for background job execution."""
    frappe.set_user(user)
    try:
        agent = Orchestrator(user=user, session_id=session_id, company=company)
        agent.handle_message(message)
    except Exception as e:
        frappe.publish_realtime(
            event="ai_error",
            message={"session_id": session_id, "error": str(e)},
            user=user,
            after_commit=False,
        )
        frappe.log_error(title="AI Agent Error", message=frappe.get_traceback())
