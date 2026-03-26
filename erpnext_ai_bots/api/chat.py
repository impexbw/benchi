import frappe
import json
from frappe import _
from erpnext_ai_bots.guards.rate_limiter import RateLimiter


# ── Category keyword maps ────────────────────────────────────────────────────

_CATEGORY_KEYWORDS = {
    "Finance": [
        "invoice", "payment", "journal", "bank", "balance",
        "p&l", "profit", "loss", "ledger", "account", "tax",
        "receivable", "payable", "expense", "budget", "supplier",
        "purchase", "overdue", "outstanding", "credit", "debit",
        "revenue", "cost", "financial", "fiscal",
    ],
    "Sales": [
        "quotation", "customer", "order", "pipeline", "quote",
        "lead", "opportunity", "crm", "sale", "deal", "prospect",
        "contract", "discount", "pricing", "client",
    ],
    "Stock": [
        "stock", "item", "warehouse", "inventory", "reorder",
        "material", "bin", "transfer", "receipt", "delivery",
        "batch", "serial", "product", "goods",
    ],
    "HR": [
        "leave", "salary", "employee", "attendance", "hr",
        "payroll", "appraisal", "recruitment", "department",
        "overtime", "holiday", "staff", "worker",
    ],
}


def _auto_categorize(text: str) -> str:
    """Return the best-matching category for a message string."""
    lower = text.lower()
    scores = {cat: 0 for cat in _CATEGORY_KEYWORDS}
    for cat, keywords in _CATEGORY_KEYWORDS.items():
        for kw in keywords:
            if kw in lower:
                scores[cat] += 1
    best_cat = max(scores, key=lambda c: scores[c])
    return best_cat if scores[best_cat] > 0 else "General"


def _user_has_openai_token(user: str) -> bool:
    """Check if the user has an active OpenAI OAuth token."""
    if not frappe.db.exists("AI OpenAI Token", user):
        return False
    status = frappe.db.get_value("AI OpenAI Token", user, "status")
    return status == "Connected"


@frappe.whitelist()
def send_message(message: str, session_id: str = None):
    """Main chat endpoint. Initiates agent processing.

    The response text is NOT returned in this HTTP response.
    It is streamed via Socket.IO events (ai_chunk, ai_done, etc.).
    """
    if not message or not message.strip():
        frappe.throw(_("Message cannot be empty"))

    user = frappe.session.user
    company = frappe.defaults.get_user_default("company", user)

    # Check if provider requires OpenAI token
    settings = frappe.get_cached_doc("AI Bot Settings")
    provider = settings.provider or "Anthropic"
    if provider == "OpenAI (ChatGPT OAuth)" and not _user_has_openai_token(user):
        return {
            "status": "no_token",
            "message": _("Please connect your ChatGPT account to use the AI Assistant."),
        }

    # Rate limiting
    limiter = RateLimiter(user)
    limiter.check()

    # Get or create session
    if not session_id:
        session = frappe.get_doc({
            "doctype": "AI Chat Session",
            "user": user,
            "company": company,
            "status": "Active",
            "title": message[:100],
            "category": _auto_categorize(message),
            "messages_json": "[]",
            "model_used": frappe.get_cached_doc("AI Bot Settings").model_name,
        })
        session.insert(ignore_permissions=True)
        session_id = session.name
        frappe.db.commit()
    else:
        session_user = frappe.db.get_value("AI Chat Session", session_id, "user")
        if session_user != user:
            frappe.throw(_("You do not own this session"), frappe.PermissionError)

    limiter.increment()

    # Enqueue agent processing as background job
    frappe.enqueue(
        "erpnext_ai_bots.agent.orchestrator.run_orchestrator",
        queue="default",
        timeout=300,
        is_async=True,
        user=user,
        session_id=session_id,
        message=message,
        company=company,
    )

    return {"session_id": session_id, "status": "processing"}


@frappe.whitelist()
def get_sessions(limit: int = 20, offset: int = 0):
    """Get the current user's chat sessions."""
    return frappe.get_all(
        "AI Chat Session",
        filters={"user": frappe.session.user},
        fields=[
            "name", "title", "status", "category", "message_count",
            "last_message_at", "total_cost_usd", "creation", "pinned",
        ],
        order_by="last_message_at desc",
        limit_page_length=min(int(limit), 50),
        limit_start=int(offset),
    )


@frappe.whitelist()
def toggle_pin(session_id: str):
    """Toggle the pinned state of a chat session."""
    session_user = frappe.db.get_value("AI Chat Session", session_id, "user")
    if session_user != frappe.session.user:
        frappe.throw(_("Access denied"), frappe.PermissionError)
    current = frappe.db.get_value("AI Chat Session", session_id, "pinned")
    new_val = 0 if current else 1
    frappe.db.set_value("AI Chat Session", session_id, "pinned", new_val)
    frappe.db.commit()
    return {"pinned": bool(new_val)}


@frappe.whitelist()
def get_history(session_id: str):
    """Get full conversation history for a session."""
    user = frappe.session.user
    session = frappe.get_doc("AI Chat Session", session_id)

    if session.user != user and "System Manager" not in frappe.get_roles(user):
        frappe.throw(_("Access denied"), frappe.PermissionError)

    return {
        "session_id": session_id,
        "title": session.title,
        "status": session.status,
        "messages": json.loads(session.messages_json or "[]"),
        "total_cost_usd": session.total_cost_usd,
        "total_input_tokens": session.total_input_tokens,
        "total_output_tokens": session.total_output_tokens,
    }


@frappe.whitelist()
def close_session(session_id: str):
    """Close/archive a chat session."""
    session_user = frappe.db.get_value("AI Chat Session", session_id, "user")
    if session_user != frappe.session.user:
        frappe.throw(_("Access denied"), frappe.PermissionError)

    frappe.db.set_value("AI Chat Session", session_id, "status", "Closed")
    frappe.db.commit()
    return {"status": "closed"}


@frappe.whitelist()
def rename_session(session_id: str, title: str):
    """Rename a chat session's title."""
    session_user = frappe.db.get_value("AI Chat Session", session_id, "user")
    if session_user != frappe.session.user:
        frappe.throw(_("Access denied"), frappe.PermissionError)

    title = (title or "").strip()[:200]
    if not title:
        frappe.throw(_("Title cannot be empty"))

    frappe.db.set_value("AI Chat Session", session_id, "title", title)
    frappe.db.commit()
    return {"status": "renamed", "title": title}


@frappe.whitelist()
def delete_session(session_id: str):
    """Permanently delete a chat session and its linked audit logs."""
    session_user = frappe.db.get_value("AI Chat Session", session_id, "user")
    if session_user != frappe.session.user:
        frappe.throw(_("Access denied"), frappe.PermissionError)

    # Delete linked AI Audit Log records first to avoid orphaned references
    audit_logs = frappe.get_all(
        "AI Audit Log",
        filters={"session": session_id},
        pluck="name",
    )
    for log_name in audit_logs:
        frappe.delete_doc("AI Audit Log", log_name, ignore_permissions=True, force=True)

    frappe.delete_doc("AI Chat Session", session_id, ignore_permissions=True, force=True)
    frappe.db.commit()
    return {"status": "deleted"}


@frappe.whitelist()
def categorize_session(session_id: str, category: str):
    """Manually set the category for a chat session."""
    valid_categories = {"General", "Finance", "Sales", "Stock", "HR"}
    if category not in valid_categories:
        frappe.throw(_("Invalid category: {0}").format(category))

    session_user = frappe.db.get_value("AI Chat Session", session_id, "user")
    if session_user != frappe.session.user:
        frappe.throw(_("Access denied"), frappe.PermissionError)

    frappe.db.set_value("AI Chat Session", session_id, "category", category)
    frappe.db.commit()
    return {"status": "categorized", "category": category}


@frappe.whitelist()
def confirm_action(action_type: str, doctype: str, name: str):
    """Explicit confirmation endpoint for write actions."""
    if action_type == "submit":
        frappe.has_permission(doctype, doc=name, ptype="submit", throw=True)
        doc = frappe.get_doc(doctype, name)
        doc.submit()
        return {"status": "submitted", "name": doc.name}
    elif action_type == "cancel":
        frappe.has_permission(doctype, doc=name, ptype="cancel", throw=True)
        doc = frappe.get_doc(doctype, name)
        doc.cancel()
        return {"status": "cancelled", "name": doc.name}
    elif action_type == "delete":
        frappe.has_permission(doctype, doc=name, ptype="delete", throw=True)
        frappe.delete_doc(doctype, name)
        return {"status": "deleted", "name": name}
    else:
        frappe.throw(_("Unknown action type: {0}").format(action_type))
