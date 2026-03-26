frappe.provide("erpnext_ai_bots");

erpnext_ai_bots.ChatWidget = class ChatWidget {
    constructor() {
        this.session_id = null;
        this.is_open = false;
        this.is_streaming = false;
        this.stream_handler = null;
        this.$current_message = null;
        this.current_message_text = "";
        this.render();
        this.bind_events();
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
                        <button class="ai-chat-close btn btn-xs">&times;</button>
                    </div>
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
    }

    toggle() {
        this.is_open = !this.is_open;
        this.$panel.toggle(this.is_open);
        this.$btn.toggleClass("ai-chat-btn-active", this.is_open);
        if (this.is_open) this.$input.focus();
    }

    new_session() {
        this.session_id = null;
        this.$messages.empty();
        this._cleanup_stream();
        this.$input.focus();
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

    async send() {
        const message = this.$input.val().trim();
        if (!message || this.is_streaming) return;

        this.$input.val("").trigger("input");
        this.add_message("user", message);
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

            this.session_id = result.message.session_id;

            // Set up stream handler IMMEDIATELY after getting session_id
            // (before the background worker can fire events)
            this._setup_stream();

            // Safety timeout: if no ai_done/ai_error arrives within 2 min,
            // unblock the UI so the user is not stuck forever.
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
