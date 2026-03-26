frappe.ui.form.on("AI Bot Settings", {
    refresh(frm) {
        // Add OpenAI OAuth widget after the oauth_section
        if (frm.fields_dict.oauth_section) {
            let $wrapper = frm.fields_dict.oauth_section.$wrapper;
            // Remove any existing widget (re-render safe)
            $wrapper.find(".openai-oauth-widget").remove();

            let $container = $('<div class="openai-oauth-container"></div>');
            $wrapper.append($container);

            frm._openai_oauth = new erpnext_ai_bots.OpenAIOAuth({
                wrapper: $container,
                on_connected: function () {
                    frappe.show_alert({
                        message: __("ChatGPT account linked. You can now use OpenAI models."),
                        indicator: "green",
                    });
                },
                on_disconnected: function () {
                    frappe.show_alert({
                        message: __("ChatGPT account disconnected."),
                        indicator: "blue",
                    });
                },
            });
            frm._openai_oauth.render();
        }
    },
});
