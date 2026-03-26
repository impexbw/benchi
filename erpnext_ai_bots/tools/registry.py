import frappe
from importlib import import_module
from typing import Dict, List

# Canonical tool map: namespace.tool_name -> module.ClassName
TOOL_MAP = {
    # Core tools
    "core.get_document": "erpnext_ai_bots.tools.core.get_document.GetDocumentTool",
    "core.get_list": "erpnext_ai_bots.tools.core.get_list.GetListTool",
    "core.create_document": "erpnext_ai_bots.tools.core.create_document.CreateDocumentTool",
    "core.update_document": "erpnext_ai_bots.tools.core.update_document.UpdateDocumentTool",
    "core.submit_document": "erpnext_ai_bots.tools.core.submit_document.SubmitDocumentTool",
    "core.run_report": "erpnext_ai_bots.tools.core.run_report.RunReportTool",
    "core.raw_sql": "erpnext_ai_bots.tools.core.raw_sql.RawSQLTool",
    "core.frappe_api": "erpnext_ai_bots.tools.core.frappe_api.FrappeAPITool",

    # Accounting tools
    "accounting.get_trial_balance": "erpnext_ai_bots.tools.accounting.trial_balance.GetTrialBalanceTool",
    "accounting.get_outstanding_invoices": "erpnext_ai_bots.tools.accounting.outstanding_invoices.GetOutstandingInvoicesTool",
    "accounting.get_bank_balances": "erpnext_ai_bots.tools.accounting.bank_balances.GetBankBalancesTool",
    "accounting.get_profit_and_loss": "erpnext_ai_bots.tools.accounting.profit_and_loss.GetProfitAndLossTool",
    "accounting.create_journal_entry": "erpnext_ai_bots.tools.accounting.journal_entry.CreateJournalEntryTool",
    "accounting.get_account_balance": "erpnext_ai_bots.tools.accounting.account_balance.GetAccountBalanceTool",

    # HR tools
    "hr.get_leave_balance": "erpnext_ai_bots.tools.hr.leave_balance.GetLeaveBalanceTool",
    "hr.create_leave_application": "erpnext_ai_bots.tools.hr.leave_application.CreateLeaveApplicationTool",
    "hr.get_salary_slip": "erpnext_ai_bots.tools.hr.salary_slip.GetSalarySlipTool",
    "hr.get_attendance_summary": "erpnext_ai_bots.tools.hr.attendance.GetAttendanceSummaryTool",
    "hr.get_employee_info": "erpnext_ai_bots.tools.hr.employee_info.GetEmployeeInfoTool",

    # Stock tools
    "stock.get_stock_balance": "erpnext_ai_bots.tools.stock.stock_balance.GetStockBalanceTool",
    "stock.create_stock_entry": "erpnext_ai_bots.tools.stock.stock_entry.CreateStockEntryTool",
    "stock.get_warehouse_summary": "erpnext_ai_bots.tools.stock.warehouse_summary.GetWarehouseSummaryTool",
    "stock.get_item_info": "erpnext_ai_bots.tools.stock.item_info.GetItemInfoTool",
    "stock.get_reorder_levels": "erpnext_ai_bots.tools.stock.reorder.GetReorderLevelsTool",

    # Sales tools
    "sales.get_pipeline": "erpnext_ai_bots.tools.sales.pipeline.GetPipelineTool",
    "sales.create_quotation": "erpnext_ai_bots.tools.sales.quotation.CreateQuotationTool",
    "sales.get_sales_orders": "erpnext_ai_bots.tools.sales.sales_order.GetSalesOrdersTool",
    "sales.get_customer_info": "erpnext_ai_bots.tools.sales.customer_info.GetCustomerInfoTool",
    "sales.get_revenue_summary": "erpnext_ai_bots.tools.sales.revenue_summary.GetRevenueSummaryTool",

    # Meta tools
    "meta.spawn_subagent": "erpnext_ai_bots.tools.meta.spawn_subagent.SpawnSubagentTool",
}


class ToolRegistry:
    """Manages tool loading, namespacing, and schema generation.
    Tools are loaded lazily and cached per-request.
    """

    def __init__(self, user: str, company: str):
        self.user = user
        self.company = company
        self._cache: Dict[str, object] = {}

    def get_tool(self, namespaced_name: str):
        """Get a tool instance by its namespaced name."""
        if namespaced_name not in self._cache:
            class_path = TOOL_MAP.get(namespaced_name)
            if not class_path:
                raise ValueError(f"Unknown tool: {namespaced_name}")

            module_path, class_name = class_path.rsplit(".", 1)
            module = import_module(module_path)
            tool_class = getattr(module, class_name)
            self._cache[namespaced_name] = tool_class(
                user=self.user, company=self.company
            )

        return self._cache[namespaced_name]

    def get_all_schemas(self) -> list:
        """Return tool schemas for ALL registered tools (Anthropic format)."""
        schemas = []
        for namespaced_name in TOOL_MAP:
            tool = self.get_tool(namespaced_name)
            schemas.append(tool.schema())
        return schemas

    def get_openai_schemas(self) -> list:
        """Return tool schemas for ALL registered tools in OpenAI Responses API format.

        Anthropic format:
            {"name": "...", "description": "...", "input_schema": {"type": "object", ...}}

        OpenAI Responses API format (NOT Chat Completions):
            {"type": "function", "name": "...", "description": "...",
             "parameters": {"type": "object", ...}}

        Note: name, description, parameters are top-level siblings of type,
        NOT nested inside a "function" key. The Responses API uses a flat structure.
        Also: dots in names are replaced with underscores (API restriction).
        """
        schemas = []
        for namespaced_name in TOOL_MAP:
            tool = self.get_tool(namespaced_name)
            anthropic_schema = tool.schema()
            # Responses API doesn't allow dots in function names
            safe_name = anthropic_schema["name"].replace(".", "_")
            openai_schema = {
                "type": "function",
                "name": safe_name,
                "description": anthropic_schema["description"],
                "parameters": anthropic_schema["input_schema"],
            }
            schemas.append(openai_schema)
        return schemas

    def get_tool_by_openai_name(self, openai_name: str):
        """Look up a tool by its OpenAI-safe name (underscores instead of dots)."""
        # Convert back: core_get_list -> core.get_list
        dotted_name = openai_name.replace("_", ".", 1)
        if dotted_name in TOOL_MAP:
            return self.get_tool(dotted_name)
        # Fallback: try direct match
        if openai_name in TOOL_MAP:
            return self.get_tool(openai_name)
        raise ValueError(f"Unknown tool: {openai_name}")

    def resolve_tool_subset(self, patterns: list) -> list:
        """Resolve glob-like patterns to tool instances.
        E.g. ["accounting.*", "core.get_document"] -> list of tool instances
        """
        tools = []
        for pattern in patterns:
            if pattern.endswith(".*"):
                namespace = pattern[:-2]
                for name in TOOL_MAP:
                    if name.startswith(namespace + "."):
                        tools.append(self.get_tool(name))
            elif pattern in TOOL_MAP:
                tools.append(self.get_tool(pattern))
        return tools
