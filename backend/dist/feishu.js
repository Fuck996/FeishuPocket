async function getTenantAccessToken(appId, appSecret) {
    const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret })
    });
    if (!response.ok) {
        throw new Error(`飞书 access_token 获取失败 (${response.status})`);
    }
    const data = (await response.json());
    if (!data.tenant_access_token) {
        throw new Error(`飞书 access_token 获取失败: ${data.msg ?? 'unknown error'}`);
    }
    return data.tenant_access_token;
}
// 构建飞书卡片 JSON 2.0 schema（支持回传按钮，触发 card.action.trigger 新版回调）
export function buildCardSchema(payload) {
    const elements = [];
    // 若有头像 img_key，第一行改为"头像 + 文本"双列布局，其余行保持 markdown
    if (payload.avatarKey && payload.lines.length > 0) {
        const [firstLine, ...restLines] = payload.lines;
        elements.push({
            tag: 'column_set',
            flex_mode: 'none',
            columns: [
                {
                    tag: 'column',
                    width: '40px',
                    vertical_align: 'center',
                    elements: [{
                            tag: 'img',
                            img_key: payload.avatarKey,
                            alt: { tag: 'plain_text', content: '头像' },
                            mode: 'crop_center',
                            corner_radius: '50%',
                            preview: false,
                            fixed_width: 36
                        }]
                },
                {
                    tag: 'column',
                    width: 'weighted',
                    weight: 1,
                    vertical_align: 'center',
                    elements: [{ tag: 'markdown', content: firstLine }]
                }
            ]
        });
        for (const line of restLines) {
            elements.push({ tag: 'markdown', content: line });
        }
    }
    else {
        for (const line of payload.lines) {
            elements.push({ tag: 'markdown', content: line });
        }
    }
    // 每个按钮独立放入 body elements，使用 value 回传给 card.action.trigger
    if (payload.actions?.length) {
        for (const action of payload.actions) {
            elements.push({
                tag: 'button',
                text: { tag: 'plain_text', content: action.text },
                type: action.type,
                value: action.value
            });
        }
    }
    return {
        schema: '2.0',
        config: { wide_screen_mode: true },
        header: {
            template: payload.color ?? 'blue',
            title: { tag: 'plain_text', content: payload.title }
        },
        body: {
            direction: 'vertical',
            elements
        }
    };
}
async function sendByWebhook(webhookUrl, payload) {
    const card = buildCardSchema(payload);
    await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // webhook 格式：{ msg_type, card: <JSON 2.0 schema> }
        body: JSON.stringify({ msg_type: 'interactive', card })
    });
}
async function sendByApp(target, payload) {
    if (!target.appId || !target.appSecret || !target.chatId) {
        return undefined;
    }
    const tenantAccessToken = await getTenantAccessToken(target.appId, target.appSecret);
    const content = payload.templateId
        ? {
            type: 'template',
            data: {
                template_id: payload.templateId,
                template_variable: payload.templateVariable ?? {}
            }
        }
        : buildCardSchema(payload);
    const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${tenantAccessToken}`,
            'Content-Type': 'application/json'
        },
        // app 发送格式：content 为 JSON 字符串
        body: JSON.stringify({
            receive_id: target.chatId,
            msg_type: 'interactive',
            content: JSON.stringify(content)
        })
    });
    if (!response.ok) {
        let detail = '';
        try {
            const errData = await response.json();
            detail = `, code=${errData.code ?? 'unknown'}, msg=${errData.msg ?? 'unknown'}`;
        }
        catch {
            detail = '';
        }
        throw new Error(`飞书应用消息发送失败 (${response.status}${detail})`);
    }
    const data = await response.json();
    return data.data?.message_id;
}
export async function sendFeishuCard(target, payload) {
    if (!target) {
        return undefined;
    }
    if (typeof target === 'string') {
        await sendByWebhook(target, payload);
        return undefined;
    }
    if (target.mode === 'app') {
        return await sendByApp(target, payload);
    }
    if (target.mode === 'webhook' && target.webhookUrl) {
        await sendByWebhook(target.webhookUrl, payload);
        return undefined;
    }
    // 兼容未指定 mode 的场景：优先应用机器人，其次 webhook。
    if (target.appId && target.appSecret && target.chatId) {
        return await sendByApp(target, payload);
    }
    if (target.webhookUrl) {
        await sendByWebhook(target.webhookUrl, payload);
    }
    return undefined;
}
