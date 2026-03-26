"""OAuth 2.0 PKCE client for the commercial branch.

In the commercial branch, OAuth PKCE is used for:
- Enterprise: LICENSE VALIDATION against the Benchi license server
- SaaS: Not used (session auth)
"""
import frappe
import hashlib
import base64
import secrets
import json
import requests
from urllib.parse import urlencode


class OAuthPKCEClient:
    """
    OAuth 2.0 Authorization Code + PKCE for license validation.

    Flow:
    1. Generate code_verifier (random 128 chars) and code_challenge (SHA256 hash)
    2. Redirect admin to license server /oauth/authorize with code_challenge
    3. Admin authenticates on license server, grants access
    4. License server redirects back with authorization_code
    5. Exchange code + code_verifier for access_token + refresh_token
    6. Use access_token for license validation API calls
    7. Refresh token when expired
    """

    def __init__(self):
        self.settings = frappe.get_cached_doc("AI Bot Settings")
        self.base_url = self.settings.license_server_url or "https://license.benchi.io"
        self.client_id = self.settings.oauth_client_id

    def generate_auth_url(self, redirect_uri: str) -> dict:
        """
        Step 1: Generate PKCE challenge and return the authorization URL.
        Stores code_verifier in the AI License doc for later exchange.
        """
        # Generate code_verifier: 128 random URL-safe chars
        code_verifier = secrets.token_urlsafe(96)

        # Generate code_challenge: SHA256(code_verifier), base64url-encoded
        digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
        code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")

        # Generate state for CSRF protection
        state = secrets.token_urlsafe(32)

        # Store verifier and state in the AI License Single doc
        license_doc = frappe.get_doc("AI License")
        license_doc.oauth_state = state
        license_doc.oauth_code_verifier = code_verifier
        license_doc.save(ignore_permissions=True)
        frappe.db.commit()

        # Build authorization URL
        params = {
            "response_type": "code",
            "client_id": self.client_id,
            "redirect_uri": redirect_uri,
            "scope": "license:validate license:read",
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }

        auth_url = f"{self.base_url}/oauth/authorize?{urlencode(params)}"
        return {"auth_url": auth_url, "state": state}

    def exchange_code(self, authorization_code: str, state: str,
                      redirect_uri: str) -> dict:
        """
        Step 2: Exchange the authorization code for tokens.
        Validates state parameter to prevent CSRF.
        """
        license_doc = frappe.get_doc("AI License")

        # Verify state
        if state != license_doc.oauth_state:
            frappe.throw("OAuth state mismatch. Possible CSRF attack.")

        # Exchange code for tokens
        response = requests.post(
            f"{self.base_url}/oauth/token",
            data={
                "grant_type": "authorization_code",
                "client_id": self.client_id,
                "code": authorization_code,
                "redirect_uri": redirect_uri,
                "code_verifier": license_doc.get_password("oauth_code_verifier"),
            },
            timeout=30,
        )

        if response.status_code != 200:
            frappe.throw(f"OAuth token exchange failed: {response.text}")

        tokens = response.json()

        # Store tokens in AI Bot Settings
        settings = frappe.get_doc("AI Bot Settings")
        settings.oauth_token = tokens["access_token"]
        settings.oauth_token_expiry = frappe.utils.add_to_date(
            frappe.utils.now_datetime(),
            seconds=tokens.get("expires_in", 3600)
        )
        settings.save(ignore_permissions=True)

        # Clear PKCE state from license doc
        license_doc.oauth_state = ""
        license_doc.oauth_code_verifier = ""
        license_doc.save(ignore_permissions=True)
        frappe.db.commit()

        return {
            "status": "authenticated",
            "expires_in": tokens.get("expires_in", 3600),
        }

    def validate_license(self) -> dict:
        """
        Use the stored access token to validate the license with the
        central server. Called periodically (every 24h) and on startup.
        """
        settings = frappe.get_cached_doc("AI Bot Settings")
        token = settings.get_password("oauth_token")

        if not token:
            return {"valid": False, "error": "No OAuth token. Run activation flow."}

        try:
            response = requests.post(
                f"{self.base_url}/api/v1/license/validate",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "license_key": settings.get_password("license_key"),
                    "site_url": frappe.utils.get_url(),
                    "app_version": self._get_app_version(),
                },
                timeout=30,
            )

            if response.status_code == 200:
                data = response.json()
                license_doc = frappe.get_doc("AI License")
                license_doc.validation_status = "Valid"
                license_doc.last_validation = frappe.utils.now_datetime()
                license_doc.features_json = json.dumps(data.get("features", {}))
                license_doc.expires_on = data.get("expires_on")
                license_doc.max_users = data.get("max_users", 0)
                license_doc.grace_period_until = None
                license_doc.save(ignore_permissions=True)
                frappe.db.commit()
                return {"valid": True, "features": data.get("features", {})}

            elif response.status_code == 401:
                # Token expired, need to re-authenticate
                return {"valid": False, "error": "Token expired. Re-authenticate."}

            else:
                return self._enter_grace_period(
                    f"Validation failed: HTTP {response.status_code}"
                )

        except requests.exceptions.RequestException as e:
            # Network error -- enter grace period
            return self._enter_grace_period(f"Network error: {e}")

    def _enter_grace_period(self, reason: str) -> dict:
        """
        If the license server is unreachable, allow 72 hours of continued
        operation before disabling.
        """
        license_doc = frappe.get_doc("AI License")

        if not license_doc.grace_period_until:
            grace_until = frappe.utils.add_to_date(
                frappe.utils.now_datetime(), hours=72
            )
            license_doc.grace_period_until = grace_until
            license_doc.validation_status = "GracePeriod"
            license_doc.save(ignore_permissions=True)
            frappe.db.commit()
            return {
                "valid": True,
                "grace_period": True,
                "grace_until": str(grace_until),
                "reason": reason,
            }

        # Check if grace period has expired
        if frappe.utils.now_datetime() > frappe.utils.get_datetime(
            license_doc.grace_period_until
        ):
            license_doc.validation_status = "Failed"
            license_doc.save(ignore_permissions=True)
            frappe.db.commit()
            return {"valid": False, "error": "Grace period expired."}

        return {
            "valid": True,
            "grace_period": True,
            "grace_until": str(license_doc.grace_period_until),
        }

    def _get_app_version(self) -> str:
        """Safely retrieve the app version string."""
        try:
            import erpnext_ai_bots
            return getattr(erpnext_ai_bots, "__version__", "0.0.0")
        except Exception:
            return "0.0.0"
