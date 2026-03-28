frappe.provide("erpnext_ai_bots");

// ── Markdown table post-processor ───────────────────────────────────────────
// frappe.markdown() uses marked.js but may be configured without GFM tables.
// We detect raw markdown table syntax surviving in the HTML output and convert
// it to proper <table> elements.

erpnext_ai_bots.render_markdown = function (text) {
    if (!text) return "";

    // First pass: use Frappe's renderer
    let html = frappe.markdown(text) || "";

    // Second pass: convert any un-rendered markdown table blocks.
    // A markdown table is: one or more lines that start/end with | and contain
    // a separator row (|---|) somewhere in the block.
    html = html.replace(
        /(<p>)?((?:\|[^\n]+\|\n?)+)(<\/p>)?/g,
        function (match, open, block) {
            // Must contain a separator row to be a real table
            if (!/\|[\s\-:]+\|/.test(block)) return match;

            const raw_lines = block.trim().split("\n").map(l => l.trim()).filter(Boolean);
            if (raw_lines.length < 2) return match;

            const parse_row = (line) =>
                line.replace(/^\||\|$/g, "").split("|").map(c => c.trim());

            const header_cells = parse_row(raw_lines[0]);
            const is_sep = (line) => /^\|?[\s\-|:]+\|?$/.test(line);

            // Find separator row index
            let sep_idx = raw_lines.findIndex((l, i) => i > 0 && is_sep(l));
            if (sep_idx === -1) return match;

            const body_lines = raw_lines.slice(sep_idx + 1);

            const th_html = header_cells
                .map(c => `<th>${c}</th>`)
                .join("");
            const tr_html = body_lines
                .map(l => {
                    const cells = parse_row(l);
                    return `<tr>${cells.map(c => `<td>${c}</td>`).join("")}</tr>`;
                })
                .join("");

            return `<table><thead><tr>${th_html}</tr></thead><tbody>${tr_html}</tbody></table>`;
        }
    );

    // Third pass: metric cards DISABLED — tables are cleaner for ERPNext data.
    // All data renders as professional tables with styled headers.

    // Fourth pass: convert ERPNext document IDs into clickable links.
    // Maps document prefixes to their ERPNext URL route slugs.
    var _doctype_slugs = {
        "SAL-QTN": "quotation",
        "SI": "sales-invoice", "SINV": "sales-invoice",
        "PI": "purchase-invoice", "PINV": "purchase-invoice",
        "SO": "sales-order",
        "PO": "purchase-order",
        "DN": "delivery-note",
        "PR": "purchase-receipt",
        "JE": "journal-entry",
        "SE": "stock-entry",
        "PE": "payment-entry",
        "LC": "landed-cost-voucher",
        "QTN": "quotation",
        "ORD": "sales-order",
        "AI-CHAT": "ai-chat-session",
        "AI-TASK": "ai-scheduled-task",
    };

    html = html.replace(
        /\b((?:SAL-QTN|SI|PI|PO|SO|DN|PR|JE|SE|LC|PE|SINV|PINV|QTN|ORD|AI-CHAT|AI-TASK|IBMOL2?-\w+-\d+-\d+|LTH-\w+-\d+|IBKAN-\w+-\d+|IBTLK-\w+-\d+)-[\w-]*\d{3,})\b/g,
        function (match) {
            // Find the matching slug by checking prefixes (longest first)
            var slug = "";
            var prefixes = Object.keys(_doctype_slugs).sort(function(a, b) { return b.length - a.length; });
            for (var i = 0; i < prefixes.length; i++) {
                if (match.startsWith(prefixes[i])) {
                    slug = _doctype_slugs[prefixes[i]] + "/";
                    break;
                }
            }
            return (
                '<a href="/app/' + slug + encodeURIComponent(match) +
                '" class="ai-doc-link" target="_blank">' + match + "</a>"
            );
        }
    );

    return html;
};

// ── Category helpers ─────────────────────────────────────────────────────────

erpnext_ai_bots.CATEGORIES = ["All", "Finance", "Sales", "Stock", "HR", "General"];

erpnext_ai_bots.CATEGORY_COLORS = {
    Finance: "green",
    Sales:   "blue",
    Stock:   "orange",
    HR:      "purple",
    General: "gray",
};

// ── ChatWidget ───────────────────────────────────────────────────────────────

erpnext_ai_bots.ChatWidget = class ChatWidget {
    constructor() {
        this.session_id = null;
        this.is_open = false;
        this.is_expanded = false;
        this.is_streaming = false;
        this.stream_handler = null;
        this.$current_message = null;
        this.current_message_text = "";
        this._active_category = "All";   // sidebar filter tab
        this._all_sessions = [];         // cached sessions array
        this._ctx_menu_target = null;    // session id under context menu
        this._last_message = null;       // last sent message text, for retry
        this._loading_session = false;   // guard against concurrent _load_session calls
        this._search_query = "";         // sidebar session search filter
        this._current_company = null;    // active company context
        this._all_companies = [];        // cached companies list
        this.render();
        this.bind_events();
        this._load_last_session();
        this._load_accent_color();
        this._load_companies();
    }

    // ── Accent color ─────────────────────────────────────────────────

    async _load_accent_color() {
        // Fetch the accent_color setting from AI Bot Settings and apply it
        // as a CSS custom property so every --ai-accent reference updates.
        try {
            const r = await frappe.call({
                method: "frappe.client.get_value",
                args: { doctype: "AI Bot Settings", fieldname: "accent_color" },
                async: true,
            });
            const color = (r.message && r.message.accent_color) || "#6c5ce7";
            document.documentElement.style.setProperty("--ai-accent", color);
        } catch (e) {
            // Silently fall back to the CSS default (#6c5ce7)
        }
    }

    // ── Company selector ────────────────────────────────────────────

    async _load_companies() {
        try {
            const r = await frappe.call({
                method: "erpnext_ai_bots.api.chat.get_companies",
                async: true,
            });
            this._all_companies = r.message || [];
            // Set default company from Frappe user defaults
            const default_co = frappe.defaults.get_default("company");
            if (!this._current_company && this._all_companies.length) {
                const found = this._all_companies.find(c => c.name === default_co);
                this._current_company = found ? found.name : this._all_companies[0].name;
            }
            this._render_company_badge();
        } catch (e) {
            // Silently fail — company context falls back to server-side default
        }
    }

    _render_company_badge() {
        const label = this._current_company || "...";
        this.$company_badge.text(label);
        this._render_company_dropdown();
    }

    _render_company_dropdown() {
        this.$company_dropdown.empty();
        for (const co of this._all_companies) {
            const is_active = co.name === this._current_company;
            const $opt = $(
                `<div class="ai-company-option${is_active ? " active" : ""}"
                      data-name="${frappe.utils.escape_html(co.name)}">
                    ${frappe.utils.escape_html(co.company_name || co.name)}
                </div>`
            );
            $opt.on("click", () => {
                this.$company_dropdown.hide();
                if (co.name === this._current_company) return;
                const old = this._current_company;
                this._current_company = co.name;
                this._render_company_badge();
                // System message so the user sees the switch in context
                const $sys = $(
                    `<div class="ai-msg ai-msg-bot ai-msg-system-note">
                        Switched to <strong>${frappe.utils.escape_html(co.company_name || co.name)}</strong>
                    </div>`
                );
                this.$messages.append($sys);
                this._scroll_bottom();
            });
            this.$company_dropdown.append($opt);
        }
    }

    // ── DOM ─────────────────────────────────────────────────────────

    render() {
        this.$btn = $(`
            <div class="ai-chat-btn" title="AI Assistant">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
            </div>
        `).appendTo("body");

        this.$panel = $(`
            <div class="ai-chat-panel" style="display:none">
                <div class="ai-chat-header">
                    <div class="ai-chat-header-left">
                        <span class="ai-chat-title">AI Assistant</span>
                        <div class="ai-company-selector" style="position:relative;display:inline-block">
                            <span class="ai-company-badge" title="Click to switch company">...</span>
                            <div class="ai-company-dropdown"></div>
                        </div>
                    </div>
                    <div class="ai-chat-header-actions">
                        <button class="ai-chat-new-session btn btn-xs" title="New conversation">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                                 stroke="currentColor" stroke-width="2">
                                <line x1="12" y1="5" x2="12" y2="19"/>
                                <line x1="5" y1="12" x2="19" y2="12"/>
                            </svg>
                        </button>
                        <button class="ai-chat-export btn btn-xs" title="Export conversation">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                                 stroke="currentColor" stroke-width="2">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                <polyline points="7 10 12 15 17 10"/>
                                <line x1="12" y1="15" x2="12" y2="3"/>
                            </svg>
                        </button>
                        <button class="ai-chat-expand btn btn-xs" title="Expand">
                            <svg class="expand-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
                                 stroke="currentColor" stroke-width="2">
                                <polyline points="15 3 21 3 21 9"/>
                                <polyline points="9 21 3 21 3 15"/>
                                <line x1="21" y1="3" x2="14" y2="10"/>
                                <line x1="3" y1="21" x2="10" y2="14"/>
                            </svg>
                            <svg class="shrink-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
                                 stroke="currentColor" stroke-width="2" style="display:none">
                                <polyline points="4 14 10 14 10 20"/>
                                <polyline points="20 10 14 10 14 4"/>
                                <line x1="14" y1="10" x2="21" y2="3"/>
                                <line x1="3" y1="21" x2="10" y2="14"/>
                            </svg>
                        </button>
                        <button class="ai-chat-close btn btn-xs">&times;</button>
                    </div>
                </div>

                <!-- Compact sessions bar (visible only in compact mode) -->
                <div class="ai-chat-sessions-bar" style="display:none">
                    <select class="ai-chat-session-select form-control form-control-sm"></select>
                </div>

                <!-- Main body: sidebar + messages -->
                <div class="ai-chat-body">
                    <!-- Sidebar (expanded mode only) -->
                    <div class="ai-chat-sidebar" style="display:none">
                        <div class="ai-sidebar-new-btn-wrap">
                            <button class="ai-sidebar-new-btn btn btn-sm btn-primary">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                                     stroke="currentColor" stroke-width="2.5">
                                    <line x1="12" y1="5" x2="12" y2="19"/>
                                    <line x1="5" y1="12" x2="19" y2="12"/>
                                </svg>
                                New Chat
                            </button>
                        </div>
                        <div class="ai-sidebar-search-wrap">
                            <input type="text" class="ai-sidebar-search form-control form-control-sm"
                                   placeholder="Search conversations..." />
                        </div>
                        <div class="ai-sidebar-category-tabs">
                            ${erpnext_ai_bots.CATEGORIES.map(c =>
                                `<button class="ai-cat-tab${c === "All" ? " active" : ""}" data-cat="${c}">${c}</button>`
                            ).join("")}
                        </div>
                        <div class="ai-sidebar-session-list"></div>
                    </div>

                    <!-- Chat area -->
                    <div class="ai-chat-main">
                        <div class="ai-chat-messages">
                            <div class="ai-templates-grid">
                                <div class="ai-template-card" data-prompt="Show me today's sales summary">
                                    <span class="ai-template-icon">📊</span>
                                    <span class="ai-template-text">Today's Sales</span>
                                </div>
                                <div class="ai-template-card" data-prompt="List all overdue invoices">
                                    <span class="ai-template-icon">⚠️</span>
                                    <span class="ai-template-text">Overdue Invoices</span>
                                </div>
                                <div class="ai-template-card" data-prompt="What is our current stock level for low-stock items?">
                                    <span class="ai-template-icon">📦</span>
                                    <span class="ai-template-text">Low Stock Alert</span>
                                </div>
                                <div class="ai-template-card" data-prompt="Show me the top 10 customers by revenue this month">
                                    <span class="ai-template-icon">👥</span>
                                    <span class="ai-template-text">Top Customers</span>
                                </div>
                                <div class="ai-template-card" data-prompt="What is our bank balance across all accounts?">
                                    <span class="ai-template-icon">🏦</span>
                                    <span class="ai-template-text">Bank Balances</span>
                                </div>
                                <div class="ai-template-card" data-prompt="Create a quotation">
                                    <span class="ai-template-icon">📝</span>
                                    <span class="ai-template-text">New Quotation</span>
                                </div>
                            </div>
                        </div>
                        <div class="ai-chat-tool-indicator" style="display:none">
                            <div class="ai-tool-spinner"></div>
                            <span class="ai-tool-name"></span>
                        </div>
                        <div class="ai-chat-input-area">
                            <textarea class="ai-chat-input"
                                placeholder="Ask about your ERPNext data..."
                                rows="1"></textarea>
                            <button class="ai-chat-send btn btn-primary btn-sm">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                                     stroke="currentColor" stroke-width="2">
                                    <line x1="22" y1="2" x2="11" y2="13"/>
                                    <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `).appendTo("body");

        // Context menu (shared, appended to body)
        this.$ctx_menu = $(`
            <div class="ai-session-ctx-menu" style="display:none">
                <button class="ai-ctx-pin">Pin</button>
                <button class="ai-ctx-rename">Rename</button>
                <button class="ai-ctx-delete">Delete</button>
            </div>
        `).appendTo("body");

        // Export dropdown (shared, appended to body)
        this.$export_menu = $(`
            <div class="ai-export-menu" style="display:none">
                <button class="ai-export-html">Export as HTML (Print / PDF)</button>
                <button class="ai-export-csv">Export as CSV</button>
            </div>
        `).appendTo("body");

        this.$messages         = this.$panel.find(".ai-chat-messages");
        this.$input            = this.$panel.find(".ai-chat-input");
        this.$tool_indicator   = this.$panel.find(".ai-chat-tool-indicator");
        this.$sidebar          = this.$panel.find(".ai-chat-sidebar");
        this.$session_list     = this.$panel.find(".ai-sidebar-session-list");
        this.$company_badge    = this.$panel.find(".ai-company-badge");
        this.$company_dropdown = this.$panel.find(".ai-company-dropdown");
    }

    // ── Events ──────────────────────────────────────────────────────

    bind_events() {
        this.$btn.on("click", () => this.toggle());
        this.$panel.find(".ai-chat-close").on("click", () => this.toggle());
        this.$panel.find(".ai-chat-new-session").on("click", () => this.new_session());
        this.$panel.find(".ai-sidebar-new-btn").on("click", () => this.new_session());
        this.$panel.find(".ai-chat-expand").on("click", () => this.toggle_expand());
        this.$panel.find(".ai-chat-send").on("click", () => this.send());

        this.$input.on("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                this.send();
            }
        });

        // Auto-resize textarea
        this.$input.on("input", function () {
            this.style.height = "auto";
            this.style.height = Math.min(this.scrollHeight, 120) + "px";
        });

        // Compact mode session selector
        this.$panel.find(".ai-chat-session-select").on("change", (e) => {
            const sid = $(e.target).val();
            if (sid) this._load_session(sid);
        });

        // Category tabs (delegated)
        this.$panel.on("click", ".ai-cat-tab", (e) => {
            const cat = $(e.currentTarget).data("cat");
            this._set_category_tab(cat);
        });

        // Context menu actions
        this.$ctx_menu.find(".ai-ctx-rename").on("click", (e) => {
            e.stopPropagation();
            const sid = this._ctx_menu_target;
            this._hide_ctx_menu();
            if (!sid) return;
            const session = this._all_sessions.find(s => s.name === sid);
            const current_title = session ? (session.title || sid) : sid;
            const new_title = prompt(__("Rename conversation"), current_title);
            if (new_title && new_title.trim() && new_title.trim() !== current_title) {
                this._rename_session(sid, new_title.trim());
            }
        });

        this.$ctx_menu.find(".ai-ctx-delete").on("click", (e) => {
            e.stopPropagation();
            const sid = this._ctx_menu_target;
            this._hide_ctx_menu();
            if (!sid) return;
            this._delete_session(sid);
        });

        this.$ctx_menu.find(".ai-ctx-pin").on("click", (e) => {
            e.stopPropagation();
            const sid = this._ctx_menu_target;
            this._hide_ctx_menu();
            if (!sid) return;
            this._toggle_pin_session(sid);
        });

        // Close context menu on outside mousedown — using mousedown instead of
        // click so it fires before the menu button's own click handler, avoiding
        // the race condition where _ctx_menu_target gets nulled prematurely.
        $(document).on("mousedown.ai_ctx", (e) => {
            if (!$(e.target).closest(".ai-session-ctx-menu").length) {
                this._hide_ctx_menu();
            }
        });

        // Export button — toggles dropdown below the button
        this.$panel.find(".ai-chat-export").on("click", (e) => {
            e.stopPropagation();
            if (this.$export_menu.is(":visible")) {
                this.$export_menu.hide();
                return;
            }
            const btn_rect = e.currentTarget.getBoundingClientRect();
            const menu_w = 210;
            const left = Math.min(btn_rect.left, window.innerWidth - menu_w - 8);
            const top  = btn_rect.bottom + 4;
            this.$export_menu.css({ left: left, top: top }).show();
        });

        // Export menu actions
        this.$export_menu.find(".ai-export-html").on("click", () => {
            this.$export_menu.hide();
            this._export_html();
        });

        this.$export_menu.find(".ai-export-csv").on("click", () => {
            this.$export_menu.hide();
            this._export_csv();
        });

        // Close export menu on outside click
        $(document).on("mousedown.ai_export", (e) => {
            if (
                !$(e.target).closest(".ai-export-menu").length &&
                !$(e.target).closest(".ai-chat-export").length
            ) {
                this.$export_menu.hide();
            }
        });

        // Sidebar search — instant client-side filtering
        this.$panel.on("input", ".ai-sidebar-search", (e) => {
            this._search_query = e.target.value.trim().toLowerCase();
            this._render_sidebar_sessions();
        });

        // Company badge — toggle dropdown
        this.$company_badge.on("click", (e) => {
            e.stopPropagation();
            const is_visible = this.$company_dropdown.is(":visible");
            this.$company_dropdown.toggle(!is_visible);
        });

        // Close company dropdown on outside click
        $(document).on("mousedown.ai_company", (e) => {
            if (!$(e.target).closest(".ai-company-selector").length) {
                this.$company_dropdown.hide();
            }
        });

        // Template cards — insert prompt and send
        this.$messages.on("click", ".ai-template-card", (e) => {
            const prompt = $(e.currentTarget).data("prompt");
            this.$input.val(prompt);
            this.send();
        });
    }

    // ── Panel open/close ─────────────────────────────────────────────

    toggle() {
        this.is_open = !this.is_open;
        this.$panel.toggle(this.is_open);
        this.$btn.toggleClass("ai-chat-btn-active", this.is_open);
        if (this.is_open) {
            this.$input.focus();
            setTimeout(() => this._scroll_bottom(), 50);
        }
    }

    toggle_expand() {
        this.is_expanded = !this.is_expanded;
        this.$panel.toggleClass("ai-chat-panel-expanded", this.is_expanded);
        this.$panel.find(".expand-icon").toggle(!this.is_expanded);
        this.$panel.find(".shrink-icon").toggle(this.is_expanded);

        // In expanded mode: show sidebar, hide compact sessions bar.
        // In compact mode: show sessions bar (if previously loaded), hide sidebar.
        if (this.is_expanded) {
            this.$sidebar.show();
            this.$panel.find(".ai-chat-sessions-bar").hide();
            this._load_sessions_list();
        } else {
            this.$sidebar.hide();
            // Keep compact bar hidden until next manual expand – it was never
            // shown in compact mode by default.
        }

        this._scroll_bottom();
    }

    // ── New session ──────────────────────────────────────────────────

    new_session() {
        this.session_id = null;
        this.$messages.empty();
        this._cleanup_stream();
        this.$input.focus();
        // Update compact selector
        this.$panel.find(".ai-chat-session-select").val("");
        // Highlight no item in sidebar
        this.$session_list.find(".ai-session-item").removeClass("active");
        // Show quick-action templates for the fresh empty state
        this._show_templates();
    }

    // ── Message rendering ────────────────────────────────────────────

    add_message(role, content) {
        const cls = role === "user" ? "ai-msg-user" : "ai-msg-bot";
        const $msg = $(`<div class="ai-msg ${cls}"></div>`);
        if (role === "user") {
            $msg.text(content);
        } else {
            $msg.html(erpnext_ai_bots.render_markdown(content));
        }
        this.$messages.append($msg);
        this._scroll_bottom();
        return $msg;
    }

    _scroll_bottom() {
        this.$messages.scrollTop(this.$messages[0].scrollHeight);
    }

    // ── Session persistence ──────────────────────────────────────────

    async _load_last_session() {
        try {
            const r = await frappe.call({
                method: "erpnext_ai_bots.api.chat.get_sessions",
                args: { limit: 1, offset: 0 },
                async: true,
            });
            const sessions = r.message || [];
            if (sessions.length && sessions[0].status === "Active") {
                this.session_id = sessions[0].name;
                await this._load_session(this.session_id);
            }
        } catch (e) {
            // Silently fail — widget still works for new sessions
        }
    }

    async _load_session(session_id) {
        // Prevent concurrent load calls (race between init and user click)
        if (this._loading_session) return;
        this._loading_session = true;

        // If switching away from a streaming session, just stop listening.
        // The backend job continues and saves to DB on its own.
        // When the user clicks back, _load_session will fetch the completed
        // response from the database.
        if (this.is_streaming) {
            this.is_streaming = false;
            this._cleanup_stream();
            this._remove_status_indicators();
            this.$panel.find(".ai-chat-send").prop("disabled", false);
            if (this._stream_timeout) {
                clearTimeout(this._stream_timeout);
                this._stream_timeout = null;
            }
        }

        this._remove_status_indicators();

        try {
            const r = await frappe.call({
                method: "erpnext_ai_bots.api.chat.get_history",
                args: { session_id: session_id },
                async: true,
            });
            const data = r.message || {};
            this.session_id = session_id;
            this.$messages.empty();

            const messages = data.messages || [];
            const visible_messages = messages.filter(
                m => m.role !== "system" && (
                    typeof m.content === "string"
                        ? m.content
                        : (Array.isArray(m.content) && m.content.some(b => b.type === "text" && b.text))
                )
            );

            for (const msg of visible_messages) {
                let content = msg.content;
                if (Array.isArray(content)) {
                    const texts = content
                        .filter(b => b.type === "text" && b.text)
                        .map(b => b.text);
                    content = texts.join("\n");
                }
                if (content) {
                    this.add_message(msg.role, content);
                }
            }

            // Show templates only when the session has no visible messages
            if (visible_messages.length === 0) {
                this._show_templates();
            } else {
                this.$messages.find(".ai-templates-grid").hide();
            }

            // Highlight active item in sidebar
            this.$session_list.find(".ai-session-item").removeClass("active");
            this.$session_list
                .find(`.ai-session-item[data-sid="${session_id}"]`)
                .addClass("active");

            // Let the DOM finish rendering all message nodes before scrolling
            this._scroll_bottom();
            setTimeout(() => this._scroll_bottom(), 100);
        } catch (e) {
            // Silently fail
        } finally {
            this._loading_session = false;
        }
    }

    async _load_sessions_list() {
        try {
            const r = await frappe.call({
                method: "erpnext_ai_bots.api.chat.get_sessions",
                args: { limit: 50, offset: 0 },
                async: true,
            });
            this._all_sessions = r.message || [];
            this._render_sidebar_sessions();
            // Also refresh compact select if it was open
            this._render_compact_select();
        } catch (e) {
            // Silently fail
        }
    }

    // ── Sidebar rendering ─────────────────────────────────────────────

    _set_category_tab(cat) {
        this._active_category = cat;
        this.$panel.find(".ai-cat-tab").removeClass("active");
        this.$panel.find(`.ai-cat-tab[data-cat="${cat}"]`).addClass("active");
        this._render_sidebar_sessions();
    }

    _render_sidebar_sessions() {
        let filtered = this._active_category === "All"
            ? this._all_sessions
            : this._all_sessions.filter(s =>
                (s.category || "General") === this._active_category
              );

        // Apply search query filter (instant, client-side)
        if (this._search_query) {
            filtered = filtered.filter(s =>
                (s.title || "").toLowerCase().includes(this._search_query)
            );
        }

        // Pinned sessions float to the top, order within each group preserved
        const sorted = [
            ...filtered.filter(s => s.pinned),
            ...filtered.filter(s => !s.pinned),
        ];

        this.$session_list.empty();

        if (!sorted.length) {
            this.$session_list.append(
                `<div class="ai-sidebar-empty">No conversations yet</div>`
            );
            return;
        }

        for (const s of sorted) {
            const title   = (s.title || s.name).substring(0, 40);
            const cat     = s.category || "General";
            const color   = erpnext_ai_bots.CATEGORY_COLORS[cat] || "gray";
            const count   = s.message_count || 0;
            const date    = s.last_message_at
                ? frappe.datetime.str_to_user(s.last_message_at.substring(0, 10))
                : frappe.datetime.str_to_user(s.creation.substring(0, 10));
            const is_active = s.name === this.session_id ? " active" : "";
            // Subtle pin icon shown only for pinned sessions
            const pin_icon  = s.pinned
                ? `<span class="ai-pin-icon" title="Pinned">
                       <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                           <path d="M16 1v6l2 4H6l2-4V1h8zM12 21v-6m-4-4h8"/>
                       </svg>
                   </span>`
                : "";

            const pin_btn_label = s.pinned ? "Unpin" : "Pin";
            const $item = $(`
                <div class="ai-session-item${is_active}" data-sid="${s.name}" title="${frappe.utils.escape_html(s.title || s.name)}">
                    <div class="ai-session-item-top">
                        <span class="ai-session-title">${pin_icon}${frappe.utils.escape_html(title)}</span>
                        <span class="ai-cat-badge ai-cat-${color}">${cat}</span>
                    </div>
                    <div class="ai-session-item-meta">
                        <span class="ai-session-date">${date}</span>
                        <span class="ai-session-count">${count} msg${count !== 1 ? "s" : ""}</span>
                    </div>
                    <div class="ai-session-actions">
                        <button class="ai-session-act-pin" title="${pin_btn_label}">${s.pinned ? "📌" : "📌"}</button>
                        <button class="ai-session-act-del" title="Delete">✕</button>
                    </div>
                </div>
            `);

            $item.find(".ai-session-act-pin").on("click", (e) => {
                e.stopPropagation();
                this._toggle_pin_session(s.name);
            });

            $item.find(".ai-session-act-del").on("click", (e) => {
                e.stopPropagation();
                this._delete_session(s.name);
            });

            $item.on("click", () => {
                this._load_session(s.name);
            });

            this.$session_list.append($item);
        }
    }

    _render_compact_select() {
        const $select = this.$panel.find(".ai-chat-session-select");
        $select.empty();
        $select.append('<option value="">-- Select a conversation --</option>');
        for (const s of this._all_sessions) {
            const label = (s.title || s.name).substring(0, 60);
            const selected = s.name === this.session_id ? " selected" : "";
            $select.append(
                `<option value="${s.name}"${selected}>${label} (${s.message_count || 0} msgs)</option>`
            );
        }
    }

    // ── Context menu ─────────────────────────────────────────────────

    _show_ctx_menu(x, y, session_id) {
        this._ctx_menu_target = session_id;
        // Update pin label to reflect current pinned state
        const session = this._all_sessions.find(s => s.name === session_id);
        const is_pinned = session && session.pinned;
        this.$ctx_menu.find(".ai-ctx-pin").text(is_pinned ? __("Unpin") : __("Pin"));
        // Keep menu within viewport
        const menu_w = 140;
        const menu_h = 96;
        const left = Math.min(x, window.innerWidth - menu_w - 8);
        const top  = Math.min(y, window.innerHeight - menu_h - 8);
        this.$ctx_menu.css({ left: left, top: top }).show();
    }

    _hide_ctx_menu() {
        this.$ctx_menu.hide();
        this._ctx_menu_target = null;
    }

    // ── Session CRUD ──────────────────────────────────────────────────

    async _rename_session(session_id, new_title) {
        try {
            await frappe.call({
                method: "erpnext_ai_bots.api.chat.rename_session",
                args: { session_id: session_id, title: new_title },
                async: true,
            });
            // Update local cache and re-render
            const s = this._all_sessions.find(x => x.name === session_id);
            if (s) s.title = new_title;
            this._render_sidebar_sessions();
            frappe.show_alert({ message: __("Conversation renamed"), indicator: "green" });
        } catch (e) {
            frappe.show_alert({ message: __("Could not rename conversation"), indicator: "red" });
        }
    }

    async _toggle_pin_session(session_id) {
        try {
            const r = await frappe.call({
                method: "erpnext_ai_bots.api.chat.toggle_pin",
                args: { session_id: session_id },
                async: true,
            });
            // Update local cache
            const s = this._all_sessions.find(x => x.name === session_id);
            if (s) s.pinned = r.message && r.message.pinned ? 1 : 0;
            this._render_sidebar_sessions();
            const label = s && s.pinned ? __("Conversation pinned") : __("Conversation unpinned");
            frappe.show_alert({ message: label, indicator: "green" });
        } catch (e) {
            frappe.show_alert({ message: __("Could not update pin"), indicator: "red" });
        }
    }

    async _delete_session(session_id) {
        try {
            await frappe.call({
                method: "erpnext_ai_bots.api.chat.delete_session",
                args: { session_id: session_id },
                async: true,
            });
            // Remove from cache
            this._all_sessions = this._all_sessions.filter(s => s.name !== session_id);
            this._render_sidebar_sessions();
            // If we deleted the active session, start fresh
            if (this.session_id === session_id) {
                this.new_session();
            }
            frappe.show_alert({ message: __("Conversation deleted"), indicator: "green" });
        } catch (e) {
            frappe.show_alert({ message: __("Could not delete conversation"), indicator: "red" });
        }
    }

    // ── Send message ─────────────────────────────────────────────────

    async send(retry_message) {
        const message = retry_message || this.$input.val().trim();
        if (!message) return;

        if (!retry_message) {
            this.$input.val("").trigger("input");
            this.add_message("user", message);
            // Hide templates on first real send
            this.$messages.find(".ai-templates-grid").hide();
        }
        this.is_streaming = true;
        this._last_message = message;
        // Don't disable send — let user queue messages

        // Remove any leftover status indicators and show THINKING state
        this._remove_status_indicators();
        this.current_message_text = "";
        this._show_thinking();
        // The real bot message bubble will be created when first text chunk arrives
        this.$current_message = null;

        try {
            const result = await frappe.call({
                method: "erpnext_ai_bots.api.chat.send_message",
                args: {
                    message: message,
                    session_id: this.session_id,
                    company: this._current_company || null,
                },
                async: true,
            });

            // Handle missing OpenAI token
            if (result.message.status === "no_token") {
                this._finish_streaming();
                if (this.$current_message) this.$current_message.remove();
                this._show_connect_flow(message);
                return;
            }

            const is_new_session = !this.session_id;
            this.session_id = result.message.session_id;
            this._setup_stream();

            // After first message, refresh the sidebar/select in background
            if (is_new_session && this.is_expanded) {
                this._load_sessions_list();
            }

            // Safety timeout: 2 min
            this._stream_timeout = setTimeout(() => {
                if (this.is_streaming) {
                    this._finish_streaming();
                    if (!this.current_message_text) {
                        this._show_error("No response received — the server may be busy");
                    }
                }
            }, 120000);
        } catch (err) {
            this._finish_streaming();
            this._show_error("Something went wrong — please try again");
        }
    }

    // ── OAuth connect flow ───────────────────────────────────────────

    _show_connect_flow(pending_message) {
        this.$messages.find(".ai-connect-flow").remove();

        const $flow = $(`
            <div class="ai-connect-flow">
                <div class="ai-connect-prompt">
                    <p><strong>Connect your ChatGPT account</strong></p>
                    <p class="text-muted">To use the AI Assistant, you need to connect your ChatGPT Plus, Pro, or Max account.</p>
                    <button class="btn btn-sm btn-primary ai-connect-start-btn">Connect ChatGPT Account</button>
                </div>
                <div class="ai-connect-paste" style="display:none;">
                    <p class="text-muted" style="font-size:12px;">
                        After signing in, you will be redirected to a page that <strong>won't load</strong>.
                        Copy the <strong>full URL</strong> from your browser's address bar and paste it below.
                    </p>
                    <input type="text" class="form-control ai-connect-url-input"
                           placeholder="Paste the callback URL here..." />
                    <div style="margin-top:8px; display:flex; gap:8px;">
                        <button class="btn btn-sm btn-primary ai-connect-complete-btn">Complete</button>
                        <button class="btn btn-sm btn-default ai-connect-cancel-btn">Cancel</button>
                    </div>
                </div>
            </div>
        `);

        this.$messages.append($flow);
        this._scroll_bottom();

        $flow.find(".ai-connect-start-btn").on("click", () => {
            frappe.call({
                method: "erpnext_ai_bots.api.openai_oauth.start_oauth",
                async: true,
                callback: (r) => {
                    const data = r.message || {};
                    if (data.auth_url) {
                        window.open(data.auth_url, "_blank");
                        $flow.find(".ai-connect-prompt").hide();
                        $flow.find(".ai-connect-paste").show();
                        $flow.find(".ai-connect-url-input").focus();
                    } else {
                        frappe.show_alert({ message: __("Failed to start OAuth flow"), indicator: "red" });
                    }
                },
                error: () => {
                    frappe.show_alert({ message: __("Failed to start OAuth flow"), indicator: "red" });
                },
            });
        });

        $flow.find(".ai-connect-complete-btn").on("click", () => {
            const pasted = $flow.find(".ai-connect-url-input").val().trim();
            if (!pasted) {
                frappe.show_alert({ message: __("Please paste the callback URL"), indicator: "orange" });
                return;
            }
            let code, state;
            try {
                const url = new URL(pasted);
                code  = url.searchParams.get("code");
                state = url.searchParams.get("state");
            } catch (e) {
                frappe.show_alert({ message: __("Invalid URL"), indicator: "red" });
                return;
            }
            if (!code) {
                frappe.show_alert({ message: __("No authorization code found in URL"), indicator: "red" });
                return;
            }

            $flow.find(".ai-connect-complete-btn").prop("disabled", true).text("Connecting...");

            frappe.call({
                method: "erpnext_ai_bots.api.openai_oauth.exchange_code",
                args: { code: code, state: state || "" },
                async: true,
                callback: (r) => {
                    const data = r.message || {};
                    if (data.success) {
                        frappe.show_alert({ message: __("ChatGPT account connected!"), indicator: "green" });
                        $flow.remove();
                        if (pending_message) {
                            this.send(pending_message);
                        }
                    } else {
                        frappe.show_alert({ message: __("Connection failed. Please try again."), indicator: "red" });
                        $flow.find(".ai-connect-complete-btn").prop("disabled", false).text("Complete");
                    }
                },
                error: () => {
                    frappe.show_alert({ message: __("Connection failed. Try starting the flow again."), indicator: "red" });
                    $flow.find(".ai-connect-complete-btn").prop("disabled", false).text("Complete");
                },
            });
        });

        $flow.find(".ai-connect-cancel-btn").on("click", () => {
            $flow.remove();
        });
    }

    // ── Streaming ────────────────────────────────────────────────────

    _setup_stream() {
        this._cleanup_stream();

        this.stream_handler = new erpnext_ai_bots.stream.StreamHandler(
            this.session_id,
            {
                onChunk: (text) => {
                    // Create bot bubble on first chunk if it doesn't exist yet
                    if (!this.$current_message) {
                        // Remove thinking indicator — response has started
                        this._remove_status_indicators();
                        this.$current_message = this.add_message("assistant", "");
                    }
                    this.current_message_text += text;
                    this.$current_message.html(
                        erpnext_ai_bots.render_markdown(this.current_message_text)
                    );
                    this._scroll_bottom();
                },
                onToolStart: (tool) => {
                    // Update status text to show which tool is running
                    this._update_status_text(tool);
                },
                onToolResult: () => {
                    // no-op
                },
                onDone: () => {
                    this._finish_streaming();
                    // Add delivered tick to the bot message
                    if (this.$current_message) {
                        this._add_delivered_tick(this.$current_message);
                    }
                    // Refresh sidebar after response so message counts update
                    if (this.is_expanded) {
                        this._load_sessions_list();
                    }
                },
                onError: (error) => {
                    this._finish_streaming();
                    this._show_error("Something went wrong — please try again");
                },
            }
        );
    }

    _finish_streaming() {
        this.is_streaming = false;
        // Remove any status indicators still showing
        this._remove_status_indicators();
        // Cancel any pending tool-hide delay and hide tool indicator bar
        clearTimeout(this._tool_hide_timeout);
        this._tool_hide_timeout = null;
        this.$tool_indicator.hide();
        if (this._stream_timeout) {
            clearTimeout(this._stream_timeout);
            this._stream_timeout = null;
        }
        if (this.$current_message) {
            // Apply data-result class if the message contains a table
            if (this.$current_message.find("table").length) {
                this.$current_message.addClass("ai-msg-data");
            }
        }
        this._cleanup_stream();
    }

    // ── Status indicators ─────────────────────────────────────────────

    /** Show the animated 3-dot THINKING indicator below the user's message. */
    _show_thinking() {
        this.$status_indicator = $(`
            <div class="ai-status-indicator ai-status-thinking">
                <div class="ai-bounce-loader">
                    <span></span><span></span><span></span>
                </div>
                <span class="ai-status-text">Processing...</span>
            </div>
        `);
        this.$messages.append(this.$status_indicator);
        this._scroll_bottom();
    }

    /** Update the status text while a tool is running. */
    _update_status_text(tool_name) {
        if (this.$status_indicator && this.$status_indicator.hasClass("ai-status-thinking")) {
            this.$status_indicator.find(".ai-status-text").text(tool_name + "...");
            this._scroll_bottom();
        }
    }

    /** Remove all status indicators (thinking + error) from the message list. */
    _remove_status_indicators() {
        this.$messages.find(".ai-status-indicator").remove();
        this.$status_indicator = null;
    }

    /**
     * Show the ERROR indicator with a Retry button.
     * @param {string} msg - User-friendly error message (no technical jargon).
     */
    _show_error(msg) {
        // Remove any thinking indicator first
        this._remove_status_indicators();

        this.$status_indicator = $(`
            <div class="ai-status-indicator ai-status-error">
                <span class="ai-error-icon">!</span>
                <span class="ai-status-text">${frappe.utils.escape_html(msg)}</span>
                <button class="ai-retry-btn">Retry</button>
            </div>
        `);

        this.$status_indicator.find(".ai-retry-btn").on("click", () => {
            this._remove_status_indicators();
            if (this._last_message) {
                this.send(this._last_message);
            }
        });

        this.$messages.append(this.$status_indicator);
        this._scroll_bottom();
    }

    /** Show or re-show the quick-action templates grid in the messages area. */
    _show_templates() {
        // If the grid already exists in the DOM just make it visible
        const $existing = this.$messages.find(".ai-templates-grid");
        if ($existing.length) {
            $existing.show();
            return;
        }
        // Otherwise inject a fresh grid (e.g. after $messages.empty())
        const $grid = $(`
            <div class="ai-templates-grid">
                <div class="ai-template-card" data-prompt="Show me today's sales summary">
                    <span class="ai-template-icon">📊</span>
                    <span class="ai-template-text">Today's Sales</span>
                </div>
                <div class="ai-template-card" data-prompt="List all overdue invoices">
                    <span class="ai-template-icon">⚠️</span>
                    <span class="ai-template-text">Overdue Invoices</span>
                </div>
                <div class="ai-template-card" data-prompt="What is our current stock level for low-stock items?">
                    <span class="ai-template-icon">📦</span>
                    <span class="ai-template-text">Low Stock Alert</span>
                </div>
                <div class="ai-template-card" data-prompt="Show me the top 10 customers by revenue this month">
                    <span class="ai-template-icon">👥</span>
                    <span class="ai-template-text">Top Customers</span>
                </div>
                <div class="ai-template-card" data-prompt="What is our bank balance across all accounts?">
                    <span class="ai-template-icon">🏦</span>
                    <span class="ai-template-text">Bank Balances</span>
                </div>
                <div class="ai-template-card" data-prompt="Create a quotation">
                    <span class="ai-template-icon">📝</span>
                    <span class="ai-template-text">New Quotation</span>
                </div>
            </div>
        `);
        this.$messages.prepend($grid);
    }

    /**
     * Append a green delivered tick to the given bot message element.
     * @param {jQuery} $msg
     */
    _add_delivered_tick($msg) {
        $msg.append('<span class="ai-delivered-tick" title="Delivered">&#10003;</span>');
    }

    _cleanup_stream() {
        if (this.stream_handler) {
            this.stream_handler.destroy();
            this.stream_handler = null;
        }
    }

    // ── Export ───────────────────────────────────────────────────────

    async _export_html() {
        if (!this.session_id) {
            frappe.show_alert({ message: __("No active conversation to export"), indicator: "orange" });
            return;
        }
        try {
            const r = await frappe.call({
                method: "erpnext_ai_bots.api.chat.export_session_html",
                args: { session_id: this.session_id },
                async: true,
            });
            const data = r.message || {};
            if (!data.html) {
                frappe.show_alert({ message: __("Export failed"), indicator: "red" });
                return;
            }
            // Open in a new tab via Blob URL so the user can print to PDF
            const blob = new Blob([data.html], { type: "text/html;charset=utf-8" });
            const url  = URL.createObjectURL(blob);
            const win  = window.open(url, "_blank");
            // Revoke the object URL after the window has a chance to load it
            if (win) {
                win.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
            }
        } catch (e) {
            frappe.show_alert({ message: __("Could not export conversation"), indicator: "red" });
        }
    }

    async _export_csv() {
        if (!this.session_id) {
            frappe.show_alert({ message: __("No active conversation to export"), indicator: "orange" });
            return;
        }
        try {
            // Use a form POST so the browser triggers the file download
            // that the server sets up via frappe.response["type"] = "download".
            const base = frappe.request.url || "/api/method/";
            const url  = `/api/method/erpnext_ai_bots.api.chat.export_session_csv`
                       + `?session_id=${encodeURIComponent(this.session_id)}`
                       + `&cmd=erpnext_ai_bots.api.chat.export_session_csv`;
            // The simplest cross-browser way is a temporary <a> click
            const a = document.createElement("a");
            a.href = url;
            a.download = `${this.session_id}.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        } catch (e) {
            frappe.show_alert({ message: __("Could not export conversation"), indicator: "red" });
        }
    }
};

// Auto-initialize when desk loads
$(document).on("app_ready", () => {
    if (frappe.session.user !== "Guest") {
        erpnext_ai_bots.chat = new erpnext_ai_bots.ChatWidget();
    }
});
