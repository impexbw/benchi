app_name = "erpnext_ai_bots"
app_title = "ERPNext AI Bots"
app_publisher = "Benchi"
app_description = "AI Agent platform for ERPNext — Commercial Edition (SaaS + Enterprise licensing)"
app_version = "1.0.0"
app_icon = "octicon octicon-hubot"
app_color = "#6c5ce7"
app_email = "info@benchi.io"
app_license = "MIT"
required_apps = ["frappe", "erpnext"]

# JS/CSS includes in desk
app_include_js = [
    "/assets/erpnext_ai_bots/js/chat_stream.js",
    "/assets/erpnext_ai_bots/js/chat_widget.js",
]
app_include_css = "/assets/erpnext_ai_bots/css/chat_widget.css"

# DocType permissions
has_permission = {
    "AI Chat Session": "erpnext_ai_bots.doctype.ai_chat_session.ai_chat_session.has_permission",
}

# Scheduled tasks
scheduler_events = {
    "daily": [
        "erpnext_ai_bots.licensing.manager.periodic_validation",
    ],
    "daily_long": [
        "erpnext_ai_bots.utils.token_counter.cleanup_old_usage_records",
        "erpnext_ai_bots.billing.metering.aggregate_daily_usage",
    ],
    "cron": {
        "0 0 1 * *": [
            "erpnext_ai_bots.billing.metering.reset_monthly_counters",
        ],
    },
}

# Fixtures (default field whitelists shipped with the app)
fixtures = [
    {
        "dt": "AI Field Whitelist",
        "filters": [["ref_doctype", "in", [
            "Sales Invoice", "Purchase Invoice", "Journal Entry",
            "Sales Order", "Purchase Order", "Quotation",
            "Stock Entry", "Delivery Note", "Purchase Receipt",
            "Leave Application", "Salary Slip", "Employee",
            "Customer", "Supplier", "Item",
        ]]]
    }
]
