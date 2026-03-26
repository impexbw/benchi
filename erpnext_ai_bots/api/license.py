import frappe
import json
import requests
from frappe import _


# ---------------------------------------------------------------------------
# Shared helper
# ---------------------------------------------------------------------------

def _callback_uri() -> str:
    return (
        f"{frappe.utils.get_url()}"
        "/api/method/erpnext_ai_bots.api.license.oauth_callback"
    )


def _get_app_version() -> str:
    try:
        import erpnext_ai_bots
        return getattr(erpnext_ai_bots, "__version__", "0.0.0")
    except Exception:
        return "0.0.0"


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_activation_url():
    """
    Step 1 of OAuth PKCE: Generate the authorization URL.

    Admin calls this, then is redirected to the Benchi license server to
    authenticate. The server will redirect back to oauth_callback.

    Returns:
        {auth_url: str, state: str}
    """
    if "System Manager" not in frappe.get_roles():
        frappe.throw(_("Only System Managers can activate licenses"))

    from erpnext_ai_bots.licensing.oauth_pkce import OAuthPKCEClient
    client = OAuthPKCEClient()
    return client.generate_auth_url(_callback_uri())


@frappe.whitelist(allow_guest=True)
def oauth_callback(code: str = None, state: str = None, error: str = None):
    """
    Step 2 of OAuth PKCE: Callback from the license server.

    Exchanges the authorization code for access tokens, then immediately
    validates the license. Redirects the admin to the settings page.

    Args:
        code:  Authorization code returned by the license server
        state: State token for CSRF verification
        error: Error string if the auth server rejected the request
    """
    if error:
        frappe.throw(_("OAuth error: {0}").format(error))

    if not code or not state:
        frappe.throw(_("Missing authorization code or state"))

    from erpnext_ai_bots.licensing.oauth_pkce import OAuthPKCEClient
    client = OAuthPKCEClient()

    # exchange_code requires the same redirect_uri used to initiate the flow
    client.exchange_code(code, state, _callback_uri())

    # Validate the license immediately after receiving the token
    validation = client.validate_license()

    # Redirect to the settings page with a flash message
    frappe.local.response["type"] = "redirect"
    frappe.local.response["location"] = "/app/ai-bot-settings"
    frappe.msgprint(
        _("License activated successfully!") if validation.get("valid")
        else _("License activation failed: {0}").format(validation.get("error")),
        alert=True,
    )


@frappe.whitelist()
def activate_license(license_key: str):
    """
    Alternative activation for Enterprise/Custom: direct key activation
    without an OAuth browser redirect.

    Use this for headless servers or CLI-driven setup where a browser
    redirect is impractical.

    Args:
        license_key: The license key issued by Benchi

    Returns:
        {status: "activated", expires_on: str}
    """
    if "System Manager" not in frappe.get_roles():
        frappe.throw(_("Only System Managers can activate licenses"))

    if not license_key or not license_key.strip():
        frappe.throw(_("License key cannot be empty"))

    settings = frappe.get_doc("AI Bot Settings")
    base_url = settings.license_server_url or "https://license.benchi.io"

    try:
        response = requests.post(
            f"{base_url}/api/v1/license/activate",
            json={
                "license_key": license_key.strip(),
                "site_url": frappe.utils.get_url(),
                "app_version": _get_app_version(),
            },
            timeout=30,
        )
    except requests.exceptions.RequestException as e:
        frappe.throw(_("Could not reach license server: {0}").format(str(e)))

    if response.status_code != 200:
        frappe.throw(_("License activation failed: {0}").format(response.text))

    data = response.json()

    # Persist into the AI License Single doc
    license_doc = frappe.get_doc("AI License")
    license_doc.license_key = license_key.strip()
    license_doc.license_type = data.get("type", "Enterprise")
    license_doc.activated_on = frappe.utils.today()
    license_doc.expires_on = data.get("expires_on")
    license_doc.max_users = data.get("max_users", 0)
    license_doc.features_json = json.dumps(data.get("features", {}))
    license_doc.site_url = frappe.utils.get_url()
    license_doc.validation_status = "Valid"
    license_doc.last_validation = frappe.utils.now_datetime()
    license_doc.grace_period_until = None
    license_doc.save(ignore_permissions=True)

    # Mirror key and status into AI Bot Settings for quick access
    settings.license_key = license_key.strip()
    settings.license_status = "Active"
    settings.license_last_validated = frappe.utils.now_datetime()
    settings.save(ignore_permissions=True)

    frappe.db.commit()
    return {"status": "activated", "expires_on": data.get("expires_on")}


@frappe.whitelist()
def get_license_status():
    """
    Get the current license status for display in the settings UI.

    Returns:
        {status, type, expires_on, max_users, last_validation, grace_period_until}
        or {status: "NotActivated"} if no license has been stored yet.
    """
    try:
        license_doc = frappe.get_doc("AI License")
        return {
            "status": license_doc.validation_status,
            "type": license_doc.license_type,
            "expires_on": license_doc.expires_on,
            "max_users": license_doc.max_users,
            "last_validation": license_doc.last_validation,
            "grace_period_until": license_doc.grace_period_until,
        }
    except Exception:
        return {"status": "NotActivated"}
