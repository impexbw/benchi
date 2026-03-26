frappe.provide("erpnext_ai_bots");

erpnext_ai_bots.ChatWidget = class ChatWidget {
    constructor() {
        this.session_id = null;
        this.is_open = false;
        this.is_expanded = false;
        this.is_streaming = false;
        this.stream_handler = null;
        this.$current_message = null;
        this.current_message_text = "";
        this.render();
        this.bind_events();
        this._load_last_session();
    }

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
                <div class="ai-chat-sessions-bar" style="display:none">
                    <select class="ai-chat-session-select form-control form-control-sm"></select>
                </div>
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
        `).appendTo("body");

        this.$messages = this.$panel.find(".ai-chat-messages");
        this.$input = this.$panel.find(".ai-chat-input");
        this.$tool_indicator = this.$panel.find(".ai-chat-tool-indicator");
    }

    bind_events() {
        this.$btn.on("click", () => this.toggle());
        this.$panel.find(".ai-chat-close").on("click", () => this.toggle());
        this.$panel.find(".ai-chat-new-session").on("click", () => this.new_session());
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

        // Session selector
        this.$panel.find(".ai-chat-session-select").on("change", (e) => {
            const sid = $(e.target).val();
            if (sid) this._load_session(sid);
        });
    }

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
        this.$panel.find(".ai-chat-sessions-bar").toggle(this.is_expanded);

        if (this.is_expanded) {
            this._load_sessions_list();
        }

        this._scroll_bottom();
    }

    new_session() {
        this.session_id = null;
        this.$messages.empty();
        this._cleanup_stream();
        this.$input.focus();
        // Update session selector
        this.$panel.find(".ai-chat-session-select").val("");
    }

    add_message(role, content) {
        const cls = role === "user" ? "ai-msg-user" : "ai-msg-bot";
        const $msg = $(`<div class="ai-msg ${cls}"></div>`);
        if (role === "user") {
            $msg.text(content);
        } else {
            $msg.html(frappe.markdown(content) || "");
        }
        this.$messages.append($msg);
        this._scroll_bottom();
        return $msg;
    }

    _scroll_bottom() {
        this.$messages.scrollTop(this.$messages[0].scrollHeight);
    }

    // ── Session persistence ─────────────────────────────────────────

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
                    // Extract text from content blocks
                    const texts = content
                        .filter(b => b.type === "text" && b.text)
                        .map(b => b.text);
                    content = texts.join("\n");
                }
                if (content && msg.role !== "system") {
                    this.add_message(msg.role, content);
                }
            }

            this._scroll_bottom();
        } catch (e) {
            // Silently fail
        }
    }

    async _load_sessions_list() {
        try {
            const r = await frappe.call({
                method: "erpnext_ai_bots.api.chat.get_sessions",
                args: { limit: 20, offset: 0 },
                async: true,
            });
            const sessions = r.message || [];
            const $select = this.$panel.find(".ai-chat-session-select");
            $select.empty();
            $select.append('<option value="">-- Select a conversation --</option>');
            for (const s of sessions) {
                const label = (s.title || s.name).substring(0, 60);
                const selected = s.name === this.session_id ? " selected" : "";
                $select.append(`<option value="${s.name}"${selected}>${label} (${s.message_count || 0} msgs)</option>`);
            }
        } catch (e) {
            // Silently fail
        }
    }

    // ── Send message ────────────────────────────────────────────────

    async send(retry_message) {
        const message = retry_message || this.$input.val().trim();
        if (!message || this.is_streaming) return;

        if (!retry_message) {
            this.$input.val("").trigger("input");
            this.add_message("user", message);
        }
        this.is_streaming = true;
        this.$panel.find(".ai-chat-send").prop("disabled", true);

        // Create empty bot bubble to stream into
        this.$current_message = this.add_message("assistant", "");
        this.current_message_text = "";

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

            this.session_id = result.message.session_id;
            this._setup_stream();

            // Safety timeout: 2 min
            this._stream_timeout = setTimeout(() => {
                if (this.is_streaming) {
                    this._finish_streaming();
                    if (!this.current_message_text) {
                        this.$current_message.html(
                            '<span class="text-muted">No response received. The server may be busy -- please try again.</span>'
                        );
                    }
                }
            }, 120000);
        } catch (err) {
            this._finish_streaming();
            this.$current_message.html(
                '<span class="text-danger">Something went wrong. Please try again.</span>'
            );
        }
    }

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
                code = url.searchParams.get("code");
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

    // ── Streaming ───────────────────────────────────────────────────

    _setup_stream() {
        this._cleanup_stream();

        this.stream_handler = new erpnext_ai_bots.stream.StreamHandler(
            this.session_id,
            {
                onChunk: (text) => {
                    this.current_message_text += text;
                    this.$current_message.html(
                        frappe.markdown(this.current_message_text)
                    );
                    this._scroll_bottom();
                },
                onToolStart: (tool) => {
                    this.$tool_indicator.show();
                    this.$tool_indicator.find(".ai-tool-name").text(
                        `Running ${tool}...`
                    );
                },
                onToolResult: () => {
                    this.$tool_indicator.hide();
                },
                onDone: () => {
                    this._finish_streaming();
                },
                onError: (error) => {
                    this._finish_streaming();
                    this.add_message("assistant", `**Error:** ${error}`);
                },
            }
        );
    }

    _finish_streaming() {
        this.is_streaming = false;
        this.$tool_indicator.hide();
        this.$panel.find(".ai-chat-send").prop("disabled", false);
        if (this._stream_timeout) {
            clearTimeout(this._stream_timeout);
            this._stream_timeout = null;
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
