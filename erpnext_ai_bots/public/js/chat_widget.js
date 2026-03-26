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

    // Third pass: detect 2-column "Metric/Field/Property/Detail" tables and
    // render them as styled metric cards instead of a plain HTML table.
    html = html.replace(/<table>([\s\S]*?)<\/table>/g, function (match, inner) {
        // Extract header cells — only proceed when there are exactly 2 columns
        const headers = inner.match(/<th>(.*?)<\/th>/g);
        if (!headers || headers.length !== 2) return match;

        const first_header = headers[0].replace(/<\/?th>/g, "").trim().toLowerCase();
        const metric_headers = ["metric", "field", "property", "detail"];
        if (!metric_headers.includes(first_header)) return match;

        // Pull every data row that has exactly 2 <td> cells
        const rows = inner.match(/<tr><td>(.*?)<\/td><td>(.*?)<\/td><\/tr>/g);
        if (!rows || !rows.length) return match;

        let cards = '<div class="ai-metric-grid">';
        rows.forEach(function (row) {
            const cells = row.match(/<td>(.*?)<\/td>/g);
            if (!cells || cells.length < 2) return;
            const label = cells[0].replace(/<\/?td>/g, "");
            const value = cells[1].replace(/<\/?td>/g, "");
            cards +=
                '<div class="ai-metric-card">' +
                    '<div class="ai-metric-value">' + value + "</div>" +
                    '<div class="ai-metric-label">' + label + "</div>" +
                "</div>";
        });
        cards += "</div>";
        return cards;
    });

    // Fourth pass: convert ERPNext document IDs (e.g. SI-2026-00001,
    // SAL-QTN-2026-00264) into clickable links that open the record.
    // The pattern requires a known prefix, at least one separator segment,
    // and ends with 3+ digit run so plain words are never matched.
    html = html.replace(
        /\b((?:SI|PI|SAL-QTN|PO|SO|DN|PR|JE|SE|LC|PE|SINV|PINV|QTN|ORD|IBMOL2?-\w+-\d+-\d+|LTH-\w+-\d+|IBKAN-\w+-\d+|IBTLK-\w+-\d+|AI-CHAT)-[\w-]+\d{3,})\b/g,
        function (match) {
            return (
                '<a href="/app/' + encodeURIComponent(match) +
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
        this.render();
        this.bind_events();
        this._load_last_session();
        this._load_accent_color();
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
                    <span class="ai-chat-title">AI Assistant</span>
                    <div class="ai-chat-header-actions">
                        <button class="ai-chat-new-session btn btn-xs" title="New conversation">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                                 stroke="currentColor" stroke-width="2">
                                <line x1="12" y1="5" x2="12" y2="19"/>
                                <line x1="5" y1="12" x2="19" y2="12"/>
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
                        <div class="ai-sidebar-category-tabs">
                            ${erpnext_ai_bots.CATEGORIES.map(c =>
                                `<button class="ai-cat-tab${c === "All" ? " active" : ""}" data-cat="${c}">${c}</button>`
                            ).join("")}
                        </div>
                        <div class="ai-sidebar-session-list"></div>
                    </div>

                    <!-- Chat area -->
                    <div class="ai-chat-main">
                        <div class="ai-chat-messages"></div>
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
                <button class="ai-ctx-rename">Rename</button>
                <button class="ai-ctx-delete">Delete</button>
            </div>
        `).appendTo("body");

        this.$messages       = this.$panel.find(".ai-chat-messages");
        this.$input          = this.$panel.find(".ai-chat-input");
        this.$tool_indicator = this.$panel.find(".ai-chat-tool-indicator");
        this.$sidebar        = this.$panel.find(".ai-chat-sidebar");
        this.$session_list   = this.$panel.find(".ai-sidebar-session-list");
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
        this.$ctx_menu.find(".ai-ctx-rename").on("click", () => {
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

        this.$ctx_menu.find(".ai-ctx-delete").on("click", () => {
            const sid = this._ctx_menu_target;
            this._hide_ctx_menu();
            if (!sid) return;
            this._delete_session(sid);
        });

        // Close context menu on outside click
        $(document).on("click.ai_ctx", (e) => {
            if (!$(e.target).closest(".ai-session-ctx-menu").length) {
                this._hide_ctx_menu();
            }
        });
    }

    // ── Panel open/close ─────────────────────────────────────────────

    toggle() {
        this.is_open = !this.is_open;
        this.$panel.toggle(this.is_open);
        this.$btn.toggleClass("ai-chat-btn-active", this.is_open);
        if (this.is_open) this.$input.focus();
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
            for (const msg of messages) {
                let content = msg.content;
                if (Array.isArray(content)) {
                    const texts = content
                        .filter(b => b.type === "text" && b.text)
                        .map(b => b.text);
                    content = texts.join("\n");
                }
                if (content && msg.role !== "system") {
                    this.add_message(msg.role, content);
                }
            }

            // Highlight active item in sidebar
            this.$session_list.find(".ai-session-item").removeClass("active");
            this.$session_list
                .find(`.ai-session-item[data-sid="${session_id}"]`)
                .addClass("active");

            this._scroll_bottom();
        } catch (e) {
            // Silently fail
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
        const filtered = this._active_category === "All"
            ? this._all_sessions
            : this._all_sessions.filter(s =>
                (s.category || "General") === this._active_category
              );

        this.$session_list.empty();

        if (!filtered.length) {
            this.$session_list.append(
                `<div class="ai-sidebar-empty">No conversations yet</div>`
            );
            return;
        }

        for (const s of filtered) {
            const title   = (s.title || s.name).substring(0, 40);
            const cat     = s.category || "General";
            const color   = erpnext_ai_bots.CATEGORY_COLORS[cat] || "gray";
            const count   = s.message_count || 0;
            const date    = s.last_message_at
                ? frappe.datetime.str_to_user(s.last_message_at.substring(0, 10))
                : frappe.datetime.str_to_user(s.creation.substring(0, 10));
            const is_active = s.name === this.session_id ? " active" : "";

            const $item = $(`
                <div class="ai-session-item${is_active}" data-sid="${s.name}" title="${frappe.utils.escape_html(s.title || s.name)}">
                    <div class="ai-session-item-top">
                        <span class="ai-session-title">${frappe.utils.escape_html(title)}</span>
                        <span class="ai-cat-badge ai-cat-${color}">${cat}</span>
                    </div>
                    <div class="ai-session-item-meta">
                        <span class="ai-session-date">${date}</span>
                        <span class="ai-session-count">${count} msg${count !== 1 ? "s" : ""}</span>
                    </div>
                </div>
            `);

            $item.on("click", () => {
                this._load_session(s.name);
            });

            $item.on("contextmenu", (e) => {
                e.preventDefault();
                this._show_ctx_menu(e.pageX, e.pageY, s.name);
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
        // Keep menu within viewport
        const menu_w = 140;
        const menu_h = 76;
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
        if (!message || this.is_streaming) return;

        if (!retry_message) {
            this.$input.val("").trigger("input");
            this.add_message("user", message);
        }
        this.is_streaming = true;
        this.$panel.find(".ai-chat-send").prop("disabled", true);

        // Create bot bubble with immediate "Thinking..." indicator
        this.$current_message = this.add_message("assistant", "");
        this.current_message_text = "";
        this._thinking_steps = [];
        // Show thinking animation immediately so user sees activity
        this.$current_message.html(
            '<div class="ai-thinking-block">' +
            '<div class="ai-thinking-step"><span class="ai-thinking-dot"></span> Thinking...</div>' +
            '</div>'
        );

        try {
            const result = await frappe.call({
                method: "erpnext_ai_bots.api.chat.send_message",
                args: { message: message, session_id: this.session_id },
                async: true,
            });

            // Handle missing OpenAI token
            if (result.message.status === "no_token") {
                this._finish_streaming();
                this.$current_message.remove();
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
                        this.$current_message
                            .addClass("ai-msg-error")
                            .html('<span class="text-muted">No response received. The server may be busy — please try again.</span>');
                    }
                }
            }, 120000);
        } catch (err) {
            this._finish_streaming();
            this.$current_message
                .addClass("ai-msg-error")
                .html('<span class="text-danger">Something went wrong. Please try again.</span>');
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
                    this.current_message_text += text;
                    // Build the full HTML: thinking steps + response text
                    let thinking_html = this._thinking_steps.length
                        ? `<div class="ai-thinking-block">${this._thinking_steps.map(s =>
                            `<div class="ai-thinking-step"><span class="ai-thinking-dot"></span> ${s}</div>`
                          ).join("")}</div>`
                        : "";
                    this.$current_message.html(
                        thinking_html + erpnext_ai_bots.render_markdown(this.current_message_text)
                    );
                    this._scroll_bottom();
                },
                onToolStart: (tool) => {
                    this.$tool_indicator.show();
                    this.$tool_indicator.find(".ai-tool-name").text(`${tool}...`);
                    // Add to thinking steps (skip duplicates)
                    if (!this._thinking_steps.includes(tool)) {
                        this._thinking_steps.push(tool);
                    }
                    if (this.$current_message) {
                        let thinking_html = this._thinking_steps.map(s =>
                            `<div class="ai-thinking-step"><span class="ai-thinking-dot"></span> ${s}...</div>`
                        ).join("");
                        let response_html = this.current_message_text
                            ? erpnext_ai_bots.render_markdown(this.current_message_text)
                            : "";
                        this.$current_message.html(
                            `<div class="ai-thinking-block">${thinking_html}</div>${response_html}`
                        );
                        this._scroll_bottom();
                    }
                },
                onToolResult: () => {
                    clearTimeout(this._tool_hide_timeout);
                    this._tool_hide_timeout = setTimeout(() => {
                        this.$tool_indicator.hide();
                    }, 1200);
                },
                onDone: () => {
                    this._finish_streaming();
                    // Refresh sidebar after response so message counts update
                    if (this.is_expanded) {
                        this._load_sessions_list();
                    }
                },
                onError: (error) => {
                    this._finish_streaming();
                    const $err = this.add_message("assistant", `**Error:** ${error}`);
                    $err.addClass("ai-msg-error");
                },
            }
        );
    }

    _finish_streaming() {
        this.is_streaming = false;
        // Cancel any pending tool-hide delay and hide immediately
        clearTimeout(this._tool_hide_timeout);
        this._tool_hide_timeout = null;
        this.$tool_indicator.hide();
        this.$panel.find(".ai-chat-send").prop("disabled", false);
        if (this._stream_timeout) {
            clearTimeout(this._stream_timeout);
            this._stream_timeout = null;
        }
        if (this.$current_message) {
            // Stop thinking dots animation
            this.$current_message.find(".ai-thinking-block").addClass("ai-thinking-done");
            // Apply data-result class if the message contains a table
            if (this.$current_message.find("table").length) {
                this.$current_message.addClass("ai-msg-data");
            }
        }
        this._cleanup_stream();
    }

    _cleanup_stream() {
        if (this.stream_handler) {
            this.stream_handler.destroy();
            this.stream_handler = null;
        }
    }
};

// Auto-initialize when desk loads
$(document).on("app_ready", () => {
    if (frappe.session.user !== "Guest") {
        erpnext_ai_bots.chat = new erpnext_ai_bots.ChatWidget();
    }
});
