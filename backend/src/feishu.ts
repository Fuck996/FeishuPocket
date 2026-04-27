export interface CardAction {
  text: string;
  type: 'primary' | 'danger' | 'default';
  value: Record<string, unknown>;
}

export interface FeishuCardPayload {
  title: string;
  lines: string[];
  actions?: CardAction[];
  color?: string;
}

export interface FeishuSendTarget {
  mode?: 'app' | 'webhook';
  webhookUrl?: string;
  appId?: string;
  appSecret?: string;
  chatId?: string;
}

async function getTenantAccessToken(appId: string, appSecret: string): Promise<string> {
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

  const data = (await response.json()) as { tenant_access_token?: string; code?: number; msg?: string };
  if (!data.tenant_access_token) {
    throw new Error(`飞书 access_token 获取失败: ${data.msg ?? 'unknown error'}`);
  }

  return data.tenant_access_token;
}

// 构建飞书卡片 JSON 2.0 schema（支持回传按钮，触发 card.action.trigger 新版回调）
export function buildCardSchema(payload: FeishuCardPayload): Record<string, unknown> {
  const elements: unknown[] = payload.lines.map((line) => ({
    tag: 'markdown',
    content: line
  }));

  // 每个按钮独立放入 body elements，使用 request_callback 行为触发新版回调
  if (payload.actions?.length) {
    for (const action of payload.actions) {
      elements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: action.text },
        type: action.type,
        behaviors: [{ type: 'request_callback', value: action.value }]
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

async function sendByWebhook(webhookUrl: string, payload: FeishuCardPayload): Promise<void> {
  const card = buildCardSchema(payload);
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // webhook 格式：{ msg_type, card: <JSON 2.0 schema> }
    body: JSON.stringify({ msg_type: 'interactive', card })
  });
}

async function sendByApp(target: FeishuSendTarget, payload: FeishuCardPayload): Promise<void> {
  if (!target.appId || !target.appSecret || !target.chatId) {
    return;
  }

  const tenantAccessToken = await getTenantAccessToken(target.appId, target.appSecret);
  const card = buildCardSchema(payload);
  const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      'Content-Type': 'application/json'
    },
    // app 发送格式：content 直接是 JSON 2.0 schema 字符串
    body: JSON.stringify({
      receive_id: target.chatId,
      msg_type: 'interactive',
      content: JSON.stringify(card)
    })
  });

  if (!response.ok) {
    throw new Error(`飞书应用消息发送失败 (${response.status})`);
  }
}

export async function sendFeishuCard(target: string | undefined | FeishuSendTarget, payload: FeishuCardPayload): Promise<void> {
  if (!target) {
    return;
  }

  if (typeof target === 'string') {
    await sendByWebhook(target, payload);
    return;
  }

  if (target.mode === 'app') {
    await sendByApp(target, payload);
    return;
  }

  if (target.mode === 'webhook' && target.webhookUrl) {
    await sendByWebhook(target.webhookUrl, payload);
    return;
  }

  // 兼容未指定 mode 的场景：优先应用机器人，其次 webhook。
  if (target.appId && target.appSecret && target.chatId) {
    await sendByApp(target, payload);
    return;
  }

  if (target.webhookUrl) {
    await sendByWebhook(target.webhookUrl, payload);
  }
}
