"""ChatGPT Codex API client.

Calls the ChatGPT Codex responses API using the user's stored OAuth token.
Automatically refreshes expired tokens before making requests.
"""
import frappe
import json
import requests
from frappe import _

CODEX_API_URL = "https://chatgpt.com/backend-api/codex/responses"


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

    def send(self, message: str, model: str = "gpt-4.1", instructions: str = None,
             stream: bool = False) -> dict:
        """Send a message to the Codex API and return the response.

        Args:
            message: The user's input text.
            model: Model to use (gpt-4.1, o4-mini, etc.).
            instructions: System instructions for the model.
            stream: Whether to stream the response.

        Returns:
            The JSON response from the Codex API.
        """
        self._ensure_valid_token()

        access_token = self.token_doc.get_password("access_token")
        account_id = self.token_doc.chatgpt_account_id

        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        }
        if account_id:
            headers["chatgpt-account-id"] = account_id

        payload = {
            "model": model,
            "input": message,
            "stream": stream,
        }
        if instructions:
            payload["instructions"] = instructions

        resp = requests.post(
            CODEX_API_URL,
            headers=headers,
            json=payload,
            stream=stream,
            timeout=120,
        )

        if resp.status_code == 401:
            # Token may have been revoked — try refresh once
            self._refresh()
            access_token = self.token_doc.get_password("access_token")
            headers["Authorization"] = f"Bearer {access_token}"
            resp = requests.post(
                CODEX_API_URL,
                headers=headers,
                json=payload,
                stream=stream,
                timeout=120,
            )

        if resp.status_code != 200:
            frappe.throw(
                _("Codex API error ({0}): {1}").format(resp.status_code, resp.text[:500])
            )

        if stream:
            return self._handle_stream(resp)

        return resp.json()

    def _handle_stream(self, resp):
        """Yield chunks from a streaming Codex response."""
        chunks = []
        for line in resp.iter_lines(decode_unicode=True):
            if not line or not line.startswith("data: "):
                continue
            data_str = line[6:]
            if data_str == "[DONE]":
                break
            try:
                chunk = json.loads(data_str)
                chunks.append(chunk)
            except json.JSONDecodeError:
                continue
        return {"chunks": chunks}
