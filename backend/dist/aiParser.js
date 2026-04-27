function buildChatCompletionsEndpoint(baseUrl) {
    const normalized = (baseUrl ?? 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
    if (normalized.endsWith('/v1')) {
        return `${normalized}/chat/completions`;
    }
    if (normalized.includes('api.deepseek.com') || normalized.includes('api.openai.com')) {
        return `${normalized}/v1/chat/completions`;
    }
    return `${normalized}/chat/completions`;
}
function extractJsonObject(content) {
    const trimmed = content.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        return trimmed;
    }
    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fencedMatch?.[1]) {
        const block = fencedMatch[1].trim();
        if (block.startsWith('{') && block.endsWith('}')) {
            return block;
        }
    }
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) {
        return trimmed.slice(first, last + 1);
    }
    return null;
}
function normalizeAction(action) {
    if (action.intent === 'set_daily_allowance' || action.intent === 'set_reward_rule' || action.intent === 'deduct_expense') {
        if (action.amount !== undefined) {
            action.amount = Number(action.amount);
            if (Number.isNaN(action.amount)) {
                return { intent: 'unknown' };
            }
        }
    }
    if (action.intent === 'set_weekly_notify') {
        if (action.hour === undefined || action.minute === undefined) {
            return { intent: 'unknown' };
        }
        action.hour = Number(action.hour);
        action.minute = Number(action.minute);
        if (Number.isNaN(action.hour) || Number.isNaN(action.minute)) {
            return { intent: 'unknown' };
        }
    }
    return action;
}
function parseByRegex(message) {
    const setDaily = message.match(/(?:设置|调整).{0,8}(?:每日|每天).{0,8}(?:额度|零花钱).{0,6}(\d+(?:\.\d+)?)\s*元(?:.*?(?:给|为)?([\u4e00-\u9fa5A-Za-z0-9_-]{1,12}))?/);
    if (setDaily) {
        return {
            intent: 'set_daily_allowance',
            amount: Number(setDaily[1]),
            childName: setDaily[2]
        };
    }
    const setReward = message.match(/设置.{0,8}(?:额外)?奖励(?:项目)?([\u4e00-\u9fa5A-Za-z0-9_-]{1,16}).{0,8}(\d+(?:\.\d+)?)\s*元(?:.*?(?:给|为)?([\u4e00-\u9fa5A-Za-z0-9_-]{1,12}))?/);
    if (setReward) {
        return {
            intent: 'set_reward_rule',
            rewardKeyword: setReward[1],
            amount: Number(setReward[2]),
            childName: setReward[3]
        };
    }
    const deduct = message.match(/(?:扣除|消费|花了|支出).{0,8}(\-?\d+(?:\.\d+)?)\s*元(?:.*?(?:原因|用于|买|因为)([\u4e00-\u9fa5A-Za-z0-9_\-\s]{1,20}))?(?:.*?(?:给|为)?([\u4e00-\u9fa5A-Za-z0-9_-]{1,12}))?/);
    if (deduct) {
        return {
            intent: 'deduct_expense',
            amount: Number(deduct[1]),
            reason: deduct[2]?.trim(),
            childName: deduct[3]
        };
    }
    const weekly = message.match(/设置.{0,10}每周.{0,4}(\d{1,2})[:：](\d{1,2})/);
    if (weekly) {
        return {
            intent: 'set_weekly_notify',
            hour: Number(weekly[1]),
            minute: Number(weekly[2])
        };
    }
    const rewardTrigger = message.match(/([\u4e00-\u9fa5A-Za-z0-9_-]{1,12}).{0,3}(完成|做了|达成)([\u4e00-\u9fa5A-Za-z0-9_-]{1,16})/);
    if (rewardTrigger) {
        return {
            intent: 'reward_from_message',
            childName: rewardTrigger[1],
            rewardKeyword: rewardTrigger[3],
            reason: `完成${rewardTrigger[3]}`
        };
    }
    return { intent: 'unknown' };
}
export async function parseBotAction(message, openAiApiKey, openAiBaseUrl, model) {
    if (!openAiApiKey) {
        return parseByRegex(message);
    }
    try {
        const endpoint = buildChatCompletionsEndpoint(openAiBaseUrl);
        const prompt = `你是一个家庭零花钱系统指令解析器。
请只返回 JSON 对象，不要代码块，不要额外解释。
字段: intent, childName, amount, rewardKeyword, reason, hour, minute。
intent 只允许: set_daily_allowance|set_reward_rule|deduct_expense|set_weekly_notify|reward_from_message|unknown。
规则:
1) amount 单位是元，输出 number。
2) 设置每周通知时，hour/minute 都必须返回。
3) 无法确定时 intent=unknown。
4) 消费扣减可为负数。

示例A: "设置小明每日零花钱12元" -> {"intent":"set_daily_allowance","childName":"小明","amount":12}
示例B: "设置小明奖励项目家务5元" -> {"intent":"set_reward_rule","childName":"小明","rewardKeyword":"家务","amount":5}
示例C: "扣除小明8元买零食" -> {"intent":"deduct_expense","childName":"小明","amount":8,"reason":"买零食"}
示例D: "设置每周统计通知20:30" -> {"intent":"set_weekly_notify","hour":20,"minute":30}

消息: ${message}`;
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${openAiApiKey}`
            },
            body: JSON.stringify({
                model: model ?? 'gpt-4o-mini',
                temperature: 0,
                messages: [
                    { role: 'system', content: '你只返回 JSON。' },
                    { role: 'user', content: prompt }
                ]
            })
        });
        if (!response.ok) {
            return parseByRegex(message);
        }
        const data = (await response.json());
        const content = data.choices?.[0]?.message?.content?.trim();
        if (!content) {
            return parseByRegex(message);
        }
        const jsonText = extractJsonObject(content);
        if (!jsonText) {
            return parseByRegex(message);
        }
        const parsed = normalizeAction(JSON.parse(jsonText));
        if (!parsed.intent) {
            return parseByRegex(message);
        }
        return parsed;
    }
    catch {
        return parseByRegex(message);
    }
}
