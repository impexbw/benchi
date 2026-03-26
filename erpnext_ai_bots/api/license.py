import frappe
import json
import requests
from frappe import _


@frappe.whitelist()
def get_activation_url():
    """Step 1 of OAuth PKCE: Generate the authorization URL."""
    if "System Manager" not in frappe.get_roles():
        frappe.throw(_("Only System Managers can activate licenses"))

    from erpnext_ai_bots.licensing.oauth_pkce import OAuthPKCEClient
    client = OAuthPKCEClient()

    redirect_uri = f"{frappe.utils.get_url()}/api/method/erpnext_ai_bots.api.license.oauth_callback"
    return client.generate_auth_url(redirect_uri)


@frappe.whitelist(allow_guest=True)
def oauth_callback(code: str = None, state: str = None, error: str = None):
    """Step 2 of OAuth PKCE: Callback from the license server."""
    if error:
        frappe.throw(_("OAuth error: {0}").format(error))

    if not code or not state:
        frappe.throw(_("Missing authorization code or state"))

    from erpnext_ai_bots.licensing.oauth_pkce import OAuthPKCEClient
    client = OAuthPKCEClient()

    client.exchange_code(code, state)
    validation = client.validate_license()

    frappe.local.response["type"] = "redirect"
    frappe.local.response["location"] = "/app/ai-bot-settings"


@frappe.whitelist()
def activate_license(license_key: str):
    """Direct key activation without OAuth (for headless environments)."""
    if "System Manager" not in frappe.get_roles():
        frappe.throw(_("Only System Managers can activate licenses"))

    settings = frappe.get_doc("AI Bot Settings")
    base_url = settings.license_server_url or "https://license.benchi.io"

    response = requests.post(
        f"{base_url}/api/v1/license/activate",
        json={
            "license_key": license_key,
            "site_url": frappe.utils.get_url(),
            "app_version": "1.0.0",
        },
        timeout=30,
    )

    if response.status_code != 200:
        frappe.throw(_("License activation failed: {0}").format(response.text))

    data = response.json()

    license_doc = frappe.get_doc("AI License")
    license_doc.license_key = license_key
    license_doc.license_type = data.get("type", "Enterprise")
    license_doc.activated_on = frappe.utils.today()
    license_doc.expires_on = data.get("expires_on")
    license_doc.max_users = data.get("max_users", 0)
    license_doc.features_json = json.dumps(data.get("features", {}))
    license_doc.site_url = frappe.utils.get_url()
    license_doc.validation_status = "Valid"
    license_doc.last_validation = frappe.utils.now_datetime()
    license_doc.save(ignore_permissions=True)

    settings.license_key = license_key
    settings.license_status = "Active"
    settings.license_last_validated = frappe.utils.now_datetime()
    settings.save(ignore_permissions=True)

    frappe.db.commit()
    return {"status": "activated", "expires_on": data.get("expires_on")}


@frappe.whitelist()
def get_license_status():
    """Get the current license status."""
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
