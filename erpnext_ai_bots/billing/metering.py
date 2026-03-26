import frappe
from frappe.utils import today, add_months, getdate


def aggregate_daily_usage():
    """
    Scheduled daily. Aggregates AI Usage Records into subscription counters.
    Also generates a daily summary for admin dashboards.
    """
    subscriptions = frappe.get_all(
        "AI Subscription",
        filters={"status": "Active"},
        fields=["name", "company", "period_start", "period_end"],
    )

    for sub in subscriptions:
        usage = frappe.db.sql("""
            SELECT
                COUNT(DISTINCT session) as conversations,
                COUNT(*) as api_calls,
                SUM(input_tokens) as total_input_tokens,
                SUM(output_tokens) as total_output_tokens,
                SUM(cost_usd) as total_cost
            FROM `tabAI Usage Record`
            WHERE company = %s
              AND timestamp BETWEEN %s AND %s
        """, (sub.company, sub.period_start, sub.period_end), as_dict=True)[0]

        frappe.db.set_value("AI Subscription", sub.name, {
            "conversations_used": usage.conversations or 0,
            "tokens_used": (usage.total_input_tokens or 0) + (usage.total_output_tokens or 0),
            "cost_accrued_usd": usage.total_cost or 0,
        })

    frappe.db.commit()


def reset_monthly_counters():
    """
    Scheduled monthly. Rolls over billing periods for active subscriptions.
    """
    subscriptions = frappe.get_all(
        "AI Subscription",
        filters={"status": "Active"},
        fields=["name", "period_end"],
    )

    for sub in subscriptions:
        if getdate(sub.period_end) <= getdate(today()):
            new_start = getdate(sub.period_end)
            new_end = add_months(new_start, 1)
            frappe.db.set_value("AI Subscription", sub.name, {
                "period_start": new_start,
                "period_end": new_end,
                "conversations_used": 0,
                "messages_used": 0,
                "tokens_used": 0,
                "cost_accrued_usd": 0,
            })

    frappe.db.commit()
