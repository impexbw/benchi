import frappe
import json


class StreamBridge:
    """Bridges the Anthropic streaming API to Frappe's Socket.IO realtime system.

    Events pushed to client:
      - ai_chunk:       {session_id, text}         -- text delta
      - ai_tool_start:  {session_id, tool, input}   -- tool execution starting
      - ai_tool_result: {session_id, tool, result}   -- tool execution complete
      - ai_done:        {session_id}                 -- response complete
      - ai_error:       {session_id, error}          -- error occurred
    """

    def __init__(self, session_id: str, user: str):
        self.session_id = session_id
        self.user = user

    def process_stream(self, stream):
        """Consume the Anthropic stream, forwarding text chunks to the client.
        Returns the final accumulated Message object.
        """
        for event in stream:
            if not hasattr(event, "type"):
                continue
            if event.type == "content_block_delta":
                if hasattr(event.delta, "text"):
                    self._publish("ai_chunk", {
                        "session_id": self.session_id,
                        "text": event.delta.text,
                    })
            elif event.type == "content_block_start":
                if hasattr(event.content_block, "type"):
                    if event.content_block.type == "tool_use":
                        self._publish("ai_tool_start", {
                            "session_id": self.session_id,
                            "tool": event.content_block.name,
                        })

        return stream.get_final_message()

    def send_tool_start(self, tool_name: str, tool_input: dict):
        self._publish("ai_tool_start", {
            "session_id": self.session_id,
            "tool": tool_name,
            "input": self._safe_summary(tool_input),
        })

    def send_tool_result(self, tool_name: str, result: dict):
        self._publish("ai_tool_result", {
            "session_id": self.session_id,
            "tool": tool_name,
            "result": self._safe_summary(result),
        })

    def send_done(self):
        self._publish("ai_done", {"session_id": self.session_id})

    def send_error(self, error_message: str):
        self._publish("ai_error", {
            "session_id": self.session_id,
            "error": error_message,
        })

    def _publish(self, event: str, data: dict):
        frappe.publish_realtime(
            event=event,
            message=data,
            user=self.user,
            after_commit=False,
        )

    def _safe_summary(self, data: dict, max_len: int = 500) -> dict:
        """Truncate large payloads before sending to frontend."""
        summary = {}
        for key, value in data.items():
            s = str(value)
            if len(s) > max_len:
                summary[key] = s[:max_len] + "..."
            else:
                summary[key] = value
        return summary
