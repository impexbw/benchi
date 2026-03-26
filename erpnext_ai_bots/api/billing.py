import frappe
from frappe import _


@frappe.whitelist()
def get_usage_summary():
    """Get the current user's usage summary for the billing period."""
    company = frappe.defaults.get_user_default("company")

    sub = frappe.get_all(
        "AI Subscription",
        filters={"company": company, "status": "Active"},
        fields=["*"],
        limit=1,
    )

    if not sub:
        return {"has_subscription": False}

    sub = sub[0]
    return {
        "has_subscription": True,
        "tier": sub.tier,
        "conversations_used": sub.conversations_used,
        "conversations_limit": sub.monthly_conversation_limit,
        "messages_used": sub.messages_used,
        "messages_limit": sub.monthly_message_limit,
        "tokens_used": sub.tokens_used,
        "tokens_limit": sub.monthly_token_limit,
        "cost_accrued_usd": sub.cost_accrued_usd,
        "period_start": sub.period_start,
        "period_end": sub.period_end,
    }


@frappe.whitelist()
def get_cost_breakdown(period_start: str = None, period_end: str = None):
    """Detailed cost breakdown. System Manager only."""
    if "System Manager" not in frappe.get_roles():
        frappe.throw(_("Access denied"), frappe.PermissionError)

    if not period_start:
        period_start = frappe.utils.add_months(frappe.utils.today(), -1)
    if not period_end:
        period_end = frappe.utils.today()

    by_user = frappe.db.sql("""
        SELECT
            user,
            COUNT(DISTINCT session) as conversations,
            COUNT(*) as api_calls,
            SUM(input_tokens) as input_tokens,
            SUM(output_tokens) as output_tokens,
            SUM(cost_usd) as total_cost
        FROM `tabAI Usage Record`
        WHERE timestamp BETWEEN %s AND %s
        GROUP BY user
        ORDER BY total_cost DESC
    """, (period_start, period_end), as_dict=True)

    by_model = frappe.db.sql("""
        SELECT
            model,
            COUNT(*) as api_calls,
            SUM(input_tokens) as input_tokens,
            SUM(output_tokens) as output_tokens,
            SUM(cost_usd) as total_cost
        FROM `tabAI Usage Record`
        WHERE timestamp BETWEEN %s AND %s
        GROUP BY model
        ORDER BY total_cost DESC
    """, (period_start, period_end), as_dict=True)

    daily = frappe.db.sql("""
        SELECT
            DATE(timestamp) as date,
            COUNT(*) as api_calls,
            SUM(cost_usd) as cost
        FROM `tabAI Usage Record`
        WHERE timestamp BETWEEN %s AND %s
        GROUP BY DATE(timestamp)
        ORDER BY date
    """, (period_start, period_end), as_dict=True)

    return {
        "by_user": by_user,
        "by_model": by_model,
        "daily": daily,
        "period_start": period_start,
        "period_end": period_end,
    }
