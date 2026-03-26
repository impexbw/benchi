"""ChatGPT Codex API client.

Calls the ChatGPT Codex responses API using the user's stored OAuth token.
Automatically refreshes expired tokens before making requests.

The Codex API (chatgpt.com/backend-api/codex/responses) has specific
requirements:
  - ``input`` must be a list of message objects (not a plain string)
  - ``stream`` must be True
  - ``store`` must be False
  - Model must be a codex-supported model (e.g. gpt-5.1-codex-mini)
"""
import frappe
import json
import requests
from frappe import _

CODEX_API_URL = "https://chatgpt.com/backend-api/codex/responses"
CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models"
DEFAULT_CODEX_MODEL = "gpt-5.1-codex-mini"


class CodexClient:
    """Client for calling ChatGPT Codex API on behalf of a Frappe user."""

    def __init__(self, user: str = None):
        self.user = user or frappe.session.user
        self._token_doc = None

    @property
    def token_doc(self):
        if not self._token_doc:
            if not frappe.db.exists("AI OpenAI Token", self.user):
                frappe.throw(
                    _("No OpenAI connection found. Connect your ChatGPT account first.")
                )
            self._token_doc = frappe.get_doc("AI OpenAI Token", self.user)
        return self._token_doc

    def _ensure_valid_token(self):
        """Check token expiry and refresh if needed."""
        doc = self.token_doc
        if doc.status != "Connected":
            frappe.throw(_("OpenAI connection is {0}. Please reconnect.").format(doc.status))

        now = frappe.utils.now_datetime()
        if doc.token_expiry and now >= doc.token_expiry:
            self._refresh()

    def _refresh(self):
        """Refresh the access token using the stored refresh token."""
        from erpnext_ai_bots.api.openai_oauth import (
            CLIENT_ID, TOKEN_URL, _decode_jwt_payload,
        )

        refresh_tok = self.token_doc.get_password("refresh_token")
        if not refresh_tok:
            frappe.db.set_value("AI OpenAI Token", self.user, "status", "Expired")
            frappe.db.commit()
            frappe.throw(_("No refresh token. Please reconnect your ChatGPT account."))

        resp = requests.post(
            TOKEN_URL,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "grant_type": "refresh_token",
                "refresh_token": refresh_tok,
                "client_id": CLIENT_ID,
            },
            timeout=15,
        )

        if resp.status_code != 200:
            frappe.db.set_value("AI OpenAI Token", self.user, "status", "Expired")
            frappe.db.commit()
            frappe.throw(_("Token refresh failed. Please reconnect."))

        token_data = resp.json()
        new_access = token_data.get("access_token", "")
        new_refresh = token_data.get("refresh_token", "")
        expires_in = token_data.get("expires_in", 3600)

        doc = self.token_doc
        doc.access_token = new_access
        if new_refresh:
            doc.refresh_token = new_refresh
        doc.token_expiry = frappe.utils.add_to_date(
            frappe.utils.now_datetime(), seconds=expires_in
        )
        doc.status = "Connected"

        payload = _decode_jwt_payload(new_access)
        account_id = payload.get("https://api.openai.com/auth", {}).get(
            "chatgpt_account_id", ""
        )
        if account_id:
            doc.chatgpt_account_id = account_id

        doc.save(ignore_permissions=True)
        frappe.db.commit()
        self._token_doc = doc

    def _get_headers(self):
        """Build authorization headers for the Codex API."""
        access_token = self.token_doc.get_password("access_token")
        account_id = self.token_doc.chatgpt_account_id

        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        }
        if account_id:
            headers["chatgpt-account-id"] = account_id
        return headers

    def get_available_models(self) -> list:
        """Fetch the list of models available for this ChatGPT account."""
        self._ensure_valid_token()
        headers = self._get_headers()

        resp = requests.get(
            CODEX_MODELS_URL,
            headers=headers,
            params={"client_version": "0.1.0"},
            timeout=15,
        )
        if resp.status_code != 200:
            return []

        data = resp.json()
        return [m["slug"] for m in data.get("models", [])]

    def send(self, messages: list, model: str = None,
             instructions: str = None) -> dict:
        """Send messages to the Codex API and return the full response.

        The Codex API requires streaming, so this method consumes the full
        SSE stream and returns the assembled result.

        Args:
            messages: List of message dicts, e.g.
                      [{"role": "user", "content": "Hello"}]
            model: Codex model slug. Defaults to gpt-5.1-codex-mini.
            instructions: System instructions for the model.

        Returns:
            Dict with keys: text, usage, raw_events
        """
        self._ensure_valid_token()
        headers = self._get_headers()

        if not model:
            model = DEFAULT_CODEX_MODEL

        payload = {
            "model": model,
            "input": messages,
            "stream": True,
            "store": False,
        }
        if instructions:
            payload["instructions"] = instructions

        resp = requests.post(
            CODEX_API_URL,
            headers=headers,
            json=payload,
            stream=True,
            timeout=120,
        )

        if resp.status_code == 401:
            # Token may have been revoked -- try refresh once
            self._refresh()
            headers = self._get_headers()
            resp = requests.post(
                CODEX_API_URL,
                headers=headers,
                json=payload,
                stream=True,
                timeout=120,
            )

        if resp.status_code != 200:
            frappe.throw(
                _("Codex API error ({0}): {1}").format(resp.status_code, resp.text[:500])
            )

        return self._consume_stream(resp)

    def send_streaming(self, messages: list, model: str = None,
                       instructions: str = None, on_delta=None):
        """Send messages and yield text deltas as they arrive.

        Args:
            messages: List of message dicts.
            model: Codex model slug.
            instructions: System instructions.
            on_delta: Optional callback called with each text delta string.

        Returns:
            Dict with keys: text, usage, raw_events (after stream completes)
        """
        self._ensure_valid_token()
        headers = self._get_headers()

        if not model:
            model = DEFAULT_CODEX_MODEL

        payload = {
            "model": model,
            "input": messages,
            "stream": True,
            "store": False,
        }
        if instructions:
            payload["instructions"] = instructions

        resp = requests.post(
            CODEX_API_URL,
            headers=headers,
            json=payload,
            stream=True,
            timeout=120,
        )

        if resp.status_code == 401:
            self._refresh()
            headers = self._get_headers()
            resp = requests.post(
                CODEX_API_URL,
                headers=headers,
                json=payload,
                stream=True,
                timeout=120,
            )

        if resp.status_code != 200:
            frappe.throw(
                _("Codex API error ({0}): {1}").format(resp.status_code, resp.text[:500])
            )

        return self._consume_stream(resp, on_delta=on_delta)

    def _consume_stream(self, resp, on_delta=None) -> dict:
        """Parse the SSE stream from the Codex API.

        Returns:
            Dict with:
              - text: The full assembled response text
              - usage: Token usage dict (input_tokens, output_tokens)
              - raw_events: List of event type strings seen
        """
        full_text = ""
        usage = {}
        event_types = set()

        for line_bytes in resp.iter_lines():
            if not line_bytes:
                continue
            line = line_bytes.decode("utf-8") if isinstance(line_bytes, bytes) else line_bytes
            if not line.startswith("data: "):
                continue
            data_str = line[6:]
            if data_str == "[DONE]":
                break
            try:
                chunk = json.loads(data_str)
            except json.JSONDecodeError:
                continue

            event_type = chunk.get("type", "")
            event_types.add(event_type)

            if event_type == "response.output_text.delta":
                delta = chunk.get("delta", "")
                full_text += delta
                if on_delta and delta:
                    on_delta(delta)

            elif event_type == "response.completed":
                resp_obj = chunk.get("response", {})
                usage = resp_obj.get("usage", {})

        return {
            "text": full_text,
            "usage": usage,
            "raw_events": sorted(event_types),
        }
