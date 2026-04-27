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
    if (action.intent === 'set_daily_allowance'
        || action.intent === 'set_reward_rule'
        || action.intent === 'deduct_expense'
        || action.intent === 'increase_balance'
        || action.intent === 'decrease_balance') {
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
function tryParseBalanceAdjust(message) {
    const cleaned = message.replace(/[，。！？；、]/g, ' ').trim();
    const increaseA = cleaned.match(/(?:余额增加|增加|加上|加)\s*(\+?\d+(?:\.\d+)?)\s*(?:元|块)(?:\s*(?:因为|因|由于|原因|理由)\s*([\u4e00-\u9fa5A-Za-z0-9_\-\s]{1,40}))?/);
    if (increaseA) {
        return {
            intent: 'increase_balance',
            amount: Math.abs(Number(increaseA[1])),
            reason: increaseA[2]?.trim()
        };
    }
    const increaseReasonFirst = cleaned.match(/([\u4e00-\u9fa5A-Za-z0-9_\-\s]{1,40})\s*(?:增加|加上|加|余额增加)\s*(\+?\d+(?:\.\d+)?)\s*(?:元|块)/);
    if (increaseReasonFirst && !/(?:完成|做了|达成|搞定|做完)/.test(cleaned)) {
        return {
            intent: 'increase_balance',
            amount: Math.abs(Number(increaseReasonFirst[2])),
            reason: increaseReasonFirst[1]?.trim()
        };
    }
    const increaseB = cleaned.match(/^(?:余额增加|增加|加上|加)\s*(\+?\d+(?:\.\d+)?)$/);
    if (increaseB) {
        return {
            intent: 'increase_balance',
            amount: Math.abs(Number(increaseB[1]))
        };
    }
    const decreaseA = cleaned.match(/(?:余额减少|减少|减去|减|扣掉|扣除)\s*(\-?\d+(?:\.\d+)?)\s*(?:元|块)(?:\s*(?:因为|因|由于|原因|理由)\s*([\u4e00-\u9fa5A-Za-z0-9_\-\s]{1,40}))?/);
    if (decreaseA) {
        return {
            intent: 'decrease_balance',
            amount: Math.abs(Number(decreaseA[1])),
            reason: decreaseA[2]?.trim()
        };
    }
    const decreaseReasonFirst = cleaned.match(/([\u4e00-\u9fa5A-Za-z0-9_\-\s]{1,40})\s*(?:减少|减去|减|扣掉|扣除|余额减少)\s*(\-?\d+(?:\.\d+)?)\s*(?:元|块)/);
    if (decreaseReasonFirst && !/(?:完成|做了|达成|搞定|做完)/.test(cleaned)) {
        return {
            intent: 'decrease_balance',
            amount: Math.abs(Number(decreaseReasonFirst[2])),
            reason: decreaseReasonFirst[1]?.trim()
        };
    }
    const decreaseB = cleaned.match(/^(?:余额减少|减少|减去|减|扣掉|扣除)\s*(\-?\d+(?:\.\d+)?)$/);
    if (decreaseB) {
        return {
            intent: 'decrease_balance',
            amount: Math.abs(Number(decreaseB[1]))
        };
    }
    return null;
}
function parseByRegex(message) {
    const cleaned = message.replace(/[，。！？；、]/g, ' ').trim();
    const balanceAdjustAction = tryParseBalanceAdjust(message);
    if (balanceAdjustAction) {
        return balanceAdjustAction;
    }
    const queryBalanceA = cleaned.match(/^(?:查询余额|查余额|余额|看余额|当前余额|现在余额)$/);
    if (queryBalanceA) {
        return { intent: 'query_balance' };
    }
    const queryBalanceB = cleaned.match(/(?:查询|查|看).{0,3}([\u4e00-\u9fa5A-Za-z0-9_-]{1,12})?.{0,2}余额/);
    if (queryBalanceB) {
        return {
            intent: 'query_balance',
            childName: queryBalanceB[1]
        };
    }
    const setDailyA = cleaned.match(/(?:设置|调整|改成|改为|改|定为).{0,10}(?:每日|每天).{0,8}(?:额度|零花钱)?\s*(\d+(?:\.\d+)?)\s*(?:元|块)?(?:.*?(?:给|为)?([\u4e00-\u9fa5A-Za-z0-9_-]{1,12}))?/);
    if (setDailyA) {
        return {
            intent: 'set_daily_allowance',
            amount: Number(setDailyA[1]),
            childName: setDailyA[2]
        };
    }
    const setDailyB = cleaned.match(/([\u4e00-\u9fa5A-Za-z0-9_-]{1,12}).{0,4}(?:每天|每日).{0,6}(?:零花钱|额度).{0,4}(?:改成|改为|设为|是)?\s*(\d+(?:\.\d+)?)\s*(?:元|块)?/);
    if (setDailyB) {
        return {
            intent: 'set_daily_allowance',
            childName: setDailyB[1],
            amount: Number(setDailyB[2])
        };
    }
    const setRewardA = cleaned.match(/(?:设置|新增|配置|添加).{0,8}(?:额外)?奖励(?:项目)?([\u4e00-\u9fa5A-Za-z0-9_-]{1,16}).{0,8}(\d+(?:\.\d+)?)\s*(?:元|块)(?:.*?(?:给|为)?([\u4e00-\u9fa5A-Za-z0-9_-]{1,12}))?/);
    if (setRewardA) {
        return {
            intent: 'set_reward_rule',
            rewardKeyword: setRewardA[1],
            amount: Number(setRewardA[2]),
            childName: setRewardA[3]
        };
    }
    const setRewardB = cleaned.match(/([\u4e00-\u9fa5A-Za-z0-9_-]{1,12}).{0,4}(?:奖励|奖).{0,8}([\u4e00-\u9fa5A-Za-z0-9_-]{1,16}).{0,8}(\d+(?:\.\d+)?)\s*(?:元|块)/);
    if (setRewardB) {
        return {
            intent: 'set_reward_rule',
            childName: setRewardB[1],
            rewardKeyword: setRewardB[2],
            amount: Number(setRewardB[3])
        };
    }
    const deductA = cleaned.match(/(?:扣除|扣|消费|花了|支出|记一笔消费|买了).{0,10}(\-?\d+(?:\.\d+)?)\s*(?:元|块)?(?:.*?(?:原因|用于|买|因为)([\u4e00-\u9fa5A-Za-z0-9_\-\s]{1,30}))?(?:.*?(?:给|为)?([\u4e00-\u9fa5A-Za-z0-9_-]{1,12}))?/);
    if (deductA) {
        return {
            intent: 'deduct_expense',
            amount: Number(deductA[1]),
            reason: deductA[2]?.trim(),
            childName: deductA[3]
        };
    }
    const deductB = cleaned.match(/([\u4e00-\u9fa5A-Za-z0-9_-]{1,12}).{0,8}(?:花了|消费了|扣了|支出).{0,4}(\-?\d+(?:\.\d+)?)\s*(?:元|块)(?:.*?(?:买|用于|因为)([\u4e00-\u9fa5A-Za-z0-9_\-\s]{1,30}))?/);
    if (deductB) {
        return {
            intent: 'deduct_expense',
            childName: deductB[1],
            amount: Number(deductB[2]),
            reason: deductB[3]?.trim()
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
    const rewardTriggerA = cleaned.match(/([\u4e00-\u9fa5A-Za-z0-9_-]{1,12}).{0,5}(完成|做了|达成|搞定|做完)([\u4e00-\u9fa5A-Za-z0-9_-]{1,16})/);
    if (rewardTriggerA) {
        return {
            intent: 'reward_from_message',
            childName: rewardTriggerA[1],
            rewardKeyword: rewardTriggerA[3],
            reason: `完成${rewardTriggerA[3]}`
        };
    }
    const rewardTriggerB = cleaned.match(/(?:给|帮)([\u4e00-\u9fa5A-Za-z0-9_-]{1,12}).{0,5}(?:加|奖励).{0,4}([\u4e00-\u9fa5A-Za-z0-9_-]{1,16})/);
    if (rewardTriggerB) {
        return {
            intent: 'reward_from_message',
            childName: rewardTriggerB[1],
            rewardKeyword: rewardTriggerB[2],
            reason: `完成${rewardTriggerB[2]}`
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
  字段: intent, amount, rewardKeyword, reason, hour, minute。
  intent 只允许: set_daily_allowance|set_reward_rule|deduct_expense|set_weekly_notify|reward_from_message|query_balance|increase_balance|decrease_balance|unknown。

  识别规则:
  1) amount 单位是元，输出 number。若用户说“8块”“8元钱”，统一转成 8。
  2) deduct_expense 的 amount 始终输出正数，符号由业务层处理。
  2.1) reward_from_message 如果用户原话里明确给了奖励金额，也要返回 amount，不能省略。
  3) 设置每周通知时，hour/minute 都必须返回，且是 0-23 / 0-59。
  4) childName 由业务层根据机器人绑定确定，不要返回 childName。
  5) 对口语化表达也要识别，例如：
    - “每天改12” => set_daily_allowance
    - “配个家务奖励5元” => set_reward_rule
    - “今天买文具花了18” => deduct_expense
    - “增加5元 因为表现良好” => increase_balance
    - “减少5元 因为初始金额设置错误” => decrease_balance
    - “完成家务了” => reward_from_message
    - “表现良好，奖励5元” => reward_from_message，且 amount=5
    - “查询余额” / “余额” => query_balance
  6) 仅当信息不足或语义冲突时返回 unknown。

  示例A: "设置每日零花钱12元" -> {"intent":"set_daily_allowance","amount":12}
  示例B: "把每天零花钱改成10块" -> {"intent":"set_daily_allowance","amount":10}
  示例C: "设置奖励项目家务5元" -> {"intent":"set_reward_rule","rewardKeyword":"家务","amount":5}
  示例D: "扣除8元买零食" -> {"intent":"deduct_expense","amount":8,"reason":"买零食"}
  示例E: "设置每周统计通知20:30" -> {"intent":"set_weekly_notify","hour":20,"minute":30}
  示例F: "完成了家务" -> {"intent":"reward_from_message","rewardKeyword":"家务","reason":"完成家务"}
  示例G: "查询余额" -> {"intent":"query_balance"}
  示例H: "查余额" -> {"intent":"query_balance"}
  示例I: "增加5元，因为表现良好" -> {"intent":"increase_balance","amount":5,"reason":"表现良好"}
  示例J: "减少5元，因为初始金额设置错误" -> {"intent":"decrease_balance","amount":5,"reason":"初始金额设置错误"}
  示例K: "表现良好，奖励5元" -> {"intent":"reward_from_message","rewardKeyword":"表现良好","amount":5,"reason":"表现良好"}

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
        if (parsed.intent === 'reward_from_message') {
            const balanceAdjustAction = tryParseBalanceAdjust(message);
            if (balanceAdjustAction) {
                return balanceAdjustAction;
            }
        }
        return parsed;
    }
    catch {
        return parseByRegex(message);
    }
}
