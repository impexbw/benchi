import frappe
import json
from erpnext_ai_bots.licensing.oauth_pkce import OAuthPKCEClient


class LicenseManager:
    """Facade for all license operations."""

    def __init__(self):
        self.settings = frappe.get_cached_doc("AI Bot Settings")

    def is_licensed(self) -> bool:
        """Quick check: is this installation licensed and operational?"""
        mode = self.settings.deployment_mode

        if mode == "SaaS":
            return True

        try:
            license_doc = frappe.get_cached_doc("AI License")
        except Exception:
            return False

        return license_doc.validation_status in ("Valid", "GracePeriod")

    def get_features(self) -> dict:
        """Get feature flags for this installation."""
        mode = self.settings.deployment_mode

        if mode == "SaaS":
            from erpnext_ai_bots.billing.tiers import TIERS
            subs = frappe.get_all(
                "AI Subscription",
                filters={"status": "Active"},
                fields=["tier"],
                limit=1,
                order_by="creation desc",
            )
            tier = subs[0].tier if subs else "Free"
            return TIERS.get(tier, TIERS["Free"])

        try:
            license_doc = frappe.get_cached_doc("AI License")
            if license_doc.features_json:
                return json.loads(license_doc.features_json)
        except Exception:
            pass

        return {}


def periodic_validation():
    """Scheduled daily. Revalidates enterprise licenses."""
    settings = frappe.get_cached_doc("AI Bot Settings")
    if settings.deployment_mode == "SaaS":
        return

    client = OAuthPKCEClient()
    result = client.validate_license()

    if not result.get("valid"):
        frappe.logger().error(
            f"License validation failed: {result.get('error')}"
        )
