export async function sendFeishuCard(webhookUrl, payload) {
    if (!webhookUrl) {
        return;
    }
    const card = {
        msg_type: 'interactive',
        card: {
            config: {
                wide_screen_mode: true
            },
            header: {
                template: 'blue',
                title: {
                    tag: 'plain_text',
                    content: payload.title
                }
            },
            elements: payload.lines.map((line) => ({
                tag: 'markdown',
                content: line
            }))
        }
    };
    await fetch(webhookUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(card)
    });
}
