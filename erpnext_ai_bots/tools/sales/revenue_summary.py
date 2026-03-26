import frappe
from erpnext_ai_bots.tools.base import BaseTool


class GetRevenueSummaryTool(BaseTool):
    name = "sales.get_revenue_summary"
    description = (
        "Summarise revenue from submitted Sales Invoices over a date range. "
        "Returns total revenue, invoice count, and average invoice value. "
        "When no specific customer is given, also returns the top customers by revenue. "
        "Optionally scoped to a single company or customer."
    )
    parameters = {
        "from_date": {
            "type": "string",
            "description": "Start of the reporting period in YYYY-MM-DD format.",
        },
        "to_date": {
            "type": "string",
            "description": "End of the reporting period in YYYY-MM-DD format.",
        },
        "company": {
            "type": "string",
            "description": "Limit results to this company. Omit to include all companies.",
        },
        "customer": {
            "type": "string",
            "description": "Limit results to a single customer. Omit for company-wide summary.",
        },
    }
    required_params = ["from_date", "to_date"]
    action_type = "Report"
    required_doctype = "Sales Invoice"
    required_ptype = "read"

    def execute(self, from_date, to_date, company=None, customer=None, **kwargs):
        frappe.has_permission("Sales Invoice", ptype="read", throw=True)

        filters = {
            "docstatus": 1,
            "posting_date": ["between", [from_date, to_date]],
        }
        if company or self.company:
            filters["company"] = company or self.company
        if customer:
            filters["customer"] = customer

        invoices = frappe.get_all(
            "Sales Invoice",
            filters=filters,
            fields=["name", "customer", "grand_total", "posting_date"],
        )

        total_revenue = sum(inv.get("grand_total") or 0.0 for inv in invoices)
        invoice_count = len(invoices)
        average_invoice_value = total_revenue / invoice_count if invoice_count else 0.0

        summary = {
            "from_date": from_date,
            "to_date": to_date,
            "total_revenue": total_revenue,
            "invoice_count": invoice_count,
            "average_invoice_value": average_invoice_value,
        }

        if not customer:
            # Aggregate per customer for top-customers ranking
            customer_totals: dict = {}
            for inv in invoices:
                cust = inv.get("customer") or "Unknown"
                customer_totals[cust] = customer_totals.get(cust, 0.0) + (inv.get("grand_total") or 0.0)

            top_customers = sorted(
                [{"customer": c, "revenue": v} for c, v in customer_totals.items()],
                key=lambda x: x["revenue"],
                reverse=True,
            )[:10]

            summary["top_customers"] = top_customers

        return {"summary": summary}
