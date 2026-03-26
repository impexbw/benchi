import frappe
from frappe import _


class CostGate:
    """Enforces usage quotas based on deployment mode and tier.

    COMMERCIAL BRANCH ONLY.
    - SaaS: Check monthly conversation/message/token limits per tier
    - Enterprise: Check license validity (no usage limits)
    """

    def __init__(self, user: str, company: str):
        self.user = user
        self.company = company
        self.settings = frappe.get_cached_doc("AI Bot Settings")

    def check_quota(self):
        """Raise an exception if the user has exceeded their quota."""
        mode = self.settings.deployment_mode

        if mode == "Enterprise":
            from erpnext_ai_bots.licensing.manager import LicenseManager
            mgr = LicenseManager()
            if not mgr.is_licensed():
                frappe.throw(
                    _("AI Agent is not licensed. Contact your administrator."),
                    title=_("License Required"),
                )
            return

        # SaaS -- check tier limits
        subscription = self._get_active_subscription()
        if not subscription:
            frappe.throw(
                _("No active AI subscription. Please subscribe to use the AI assistant."),
                title=_("Subscription Required"),
            )

        if (subscription.monthly_conversation_limit > 0
                and subscription.conversations_used >= subscription.monthly_conversation_limit):
            frappe.throw(
                _("Monthly conversation limit ({0}) reached. Upgrade your plan.").format(
                    subscription.monthly_conversation_limit
                ),
                title=_("Quota Exceeded"),
            )

        if (subscription.monthly_message_limit > 0
                and subscription.messages_used >= subscription.monthly_message_limit):
            frappe.throw(
                _("Monthly message limit ({0}) reached. Upgrade your plan.").format(
                    subscription.monthly_message_limit
                ),
                title=_("Quota Exceeded"),
            )

        if (subscription.monthly_token_limit > 0
                and subscription.tokens_used >= subscription.monthly_token_limit):
            frappe.throw(
                _("Monthly token limit reached. Upgrade your plan."),
                title=_("Quota Exceeded"),
            )

    def increment_usage(self, input_tokens: int, output_tokens: int):
        """Increment subscription usage counters after a successful request."""
        if self.settings.deployment_mode != "SaaS":
            return

        subscription = self._get_active_subscription()
        if not subscription:
            return

        frappe.db.set_value("AI Subscription", subscription.name, {
            "messages_used": subscription.messages_used + 1,
            "tokens_used": subscription.tokens_used + input_tokens + output_tokens,
        })

    def _get_active_subscription(self):
        subs = frappe.get_all(
            "AI Subscription",
            filters={"company": self.company, "status": "Active"},
            fields=["*"],
            limit=1,
            order_by="creation desc",
        )
        return subs[0] if subs else None
