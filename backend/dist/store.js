import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const BUILT_IN_DEEPSEEK_MODEL_ID = 'built-in-deepseek';
const BUILT_IN_PROMPT_VERSION = 'pocket-money-v6';
const BUILT_IN_MCP_PROMPTS = [
    {
        id: 'vscode-chat-report',
        name: '零花钱MCP指令识别',
        purpose: 'pocket-money',
        content: `你是零花钱指令识别引擎。请根据群聊/单聊文本识别并输出指令。\n\n小孩与控制账号绑定关系已由机器人配置确定，不需要推断权限，只做意图识别。\n\n必须支持的操作：\n1) 调整每日零花钱额度（单位：元）\n2) 设置额外奖励项目与金额（例如：家务 +5 元）\n3) 从零花钱扣除消费金额（识别时 amount 一律输出正数）\n4) 设置每周零花钱统计通知时间\n5) 识别“完成某项目”触发奖励（reward_from_message）\n6) 查询余额（query_balance）\n\n口语化兼容示例：\n- “小明每天改12”\n- “给小明配个家务奖励5块”\n- “小明今天买文具花了18”\n- “小明完成了家务”\n- “查询余额”\n\n识别约束：\n- 必须屏蔽机器人自身通知消息，避免循环触发\n- 控制账号在群聊和单聊发言都可触发\n- 信息不足或冲突时返回 unknown\n\n输出要求：\n- 只输出 JSON，不输出触发者身份判断或触发原因分析\n- 字段只允许：intent、childName、amount、rewardKeyword、reason、hour、minute\n- intent 只允许：set_daily_allowance | set_reward_rule | deduct_expense | set_weekly_notify | reward_from_message | query_balance | unknown`,
        isBuiltIn: true,
        usageCount: 0
    },
    {
        id: 'daily-digest',
        name: '金额变动通知模板',
        purpose: 'daily',
        content: `飞书卡片金额变动通知说明（支持模板动态渲染）。\n\n卡片内容与字段映射：\n- 头像：child_avatar\n- 姓名：child_name\n- 余额（变动后）：balance_after\n- 变动金额：change_amount\n- 变动原因：change_reason\n- 变动日期：change_date\n- 变动时间：change_time\n- 变动操作人：operator_name\n- 变动类型：transaction_type\n\n展示要求：\n- “变动金额 + 变动后余额”同一行展示并对比\n- 金额字段需醒目\n- 不需要 AI 模型识别，字段由系统直接填入`,
        isBuiltIn: true,
        usageCount: 0
    },
    {
        id: 'weekly-summary',
        name: '每周统计通知模板',
        purpose: 'weekly',
        content: `你是每周统计通知助手。请生成“上周零花钱统计”卡片。\n\n必须包含字段：\n1) 上周总增加金额\n2) 上周总消费金额\n3) 剩余金额\n4) 最大消费项目名称和金额\n5) AI 建议（针对零花钱使用习惯）\n\n要求：\n- 金额字段统一单位元\n- 统计区间明确\n- 建议应可执行、可落地`,
        isBuiltIn: true,
        usageCount: 0
    },
    {
        id: 'incident-report',
        name: '系统操作反馈模板',
        purpose: 'incident',
        content: `系统操作反馈通知字段说明。\n\n以下操作完成后必须回发卡片反馈：\n1) 调整每日额度\n2) 设置額外奖励项目与金额\n3) 设置每周统计通知时间\n\n卡片必须包含字段（直接填入对应字段，不要口头降述）：\n- intent：操作类型（set_daily_allowance/set_reward_rule/set_weekly_notify）\n- childName：操作对象小孩姓名（若适用）\n- amount：生效金额（小数展开）\n- hour/minute：生效时间（若为时间类操作）\n- actorUserId：操作者用户名（若消息包含）\n- status：成功/失败`,
        isBuiltIn: true,
        usageCount: 0
    },
    {
        id: 'optimization-suggestion',
        name: '控制账号触发规则模板',
        purpose: 'optimization',
        content: `控制账号权限与触发规则说明（平台内置文档）。\n\n权限设计：\n- 小孩由机器人配置绑定，每个机器人的 childIds 字段定义它可管理的小孩；\n- 每个机器人的 controllerOpenIds 字段定义哪些飞书用户有权限触发该机器人；\n- controllerOpenIds 为空则任意用户均可触发；\n- controllerOpenIds 中的用户在单聊和群聊中发言均可触发；\n- 未在 controllerOpenIds 中的用户发言必须忽略；\n- 机器人自身的消息必须忽略，防止循环。\n\n注：小孩与控制账号的绑定关系已经由机器人配置确定，不需要每次识别或推断。`,
        isBuiltIn: true,
        usageCount: 0
    }
];
const DEFAULT_STORE = {
    users: [],
    children: [],
    robots: [],
    transactions: [],
    weeklySummaries: [],
    models: [],
    prompts: [],
    config: {
        weeklyNotify: { hour: 20, minute: 0 },
        ignoreBotUserIds: [],
        defaultDailyAllowance: 10,
        builtInPromptVersion: BUILT_IN_PROMPT_VERSION
    }
};
export class JsonStore {
    filePath;
    data = structuredClone(DEFAULT_STORE);
    constructor(filePath) {
        this.filePath = filePath;
    }
    load() {
        const dirPath = path.dirname(this.filePath);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
        if (!fs.existsSync(this.filePath)) {
            this.data = structuredClone(DEFAULT_STORE);
            this.ensureBuiltInItems();
            this.save();
            return this.data;
        }
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        this.data = {
            users: parsed.users ?? [],
            children: parsed.children ?? [],
            robots: (parsed.robots ?? []).map((r) => ({
                id: r.id,
                name: r.name,
                enabled: r.enabled ?? true,
                childIds: r.childIds ?? [],
                controllerOpenIds: r.controllerOpenIds ?? [],
                feishuMode: r.feishuMode,
                feishuWebhookUrl: r.feishuWebhookUrl,
                feishuAppId: r.feishuAppId,
                feishuAppSecret: r.feishuAppSecret,
                feishuVerificationToken: r.feishuVerificationToken,
                feishuSigningSecret: r.feishuSigningSecret,
                feishuDefaultChatId: r.feishuDefaultChatId,
                lastActiveChatId: r.lastActiveChatId,
                createdAt: r.createdAt,
                updatedAt: r.updatedAt
            })),
            transactions: parsed.transactions ?? [],
            weeklySummaries: parsed.weeklySummaries ?? [],
            models: parsed.models ?? [],
            prompts: parsed.prompts ?? [],
            config: {
                weeklyNotify: parsed.config?.weeklyNotify ?? { hour: 20, minute: 0 },
                ignoreBotUserIds: parsed.config?.ignoreBotUserIds ?? [],
                defaultDailyAllowance: parsed.config?.defaultDailyAllowance ?? 10,
                lastDailyGrantDate: parsed.config?.lastDailyGrantDate,
                lastDailyGrantTimes: parsed.config?.lastDailyGrantTimes ?? {},
                builtInPromptVersion: parsed.config?.builtInPromptVersion
            }
        };
        // 兼容旧版本迁移：将全局飞书配置迁移到第一个机器人
        const oldCfg = parsed.config;
        if (oldCfg?.feishuAppId || oldCfg?.feishuWebhookUrl) {
            const firstRobot = this.data.robots[0];
            if (firstRobot && !firstRobot.feishuAppId && !firstRobot.feishuWebhookUrl) {
                firstRobot.feishuMode = oldCfg.feishuMode ?? 'app';
                firstRobot.feishuAppId = oldCfg.feishuAppId;
                firstRobot.feishuAppSecret = oldCfg.feishuAppSecret;
                firstRobot.feishuWebhookUrl = oldCfg.feishuWebhookUrl;
                firstRobot.feishuVerificationToken = oldCfg.feishuVerificationToken;
                firstRobot.feishuSigningSecret = oldCfg.feishuSigningSecret;
                firstRobot.feishuDefaultChatId = oldCfg.feishuDefaultChatId;
                firstRobot.lastActiveChatId = oldCfg.lastActiveChatId;
            }
        }
        // 增量补齐内置模型与提示词，避免破坏已有用户数据。
        const changed = this.ensureBuiltInItems();
        if (changed) {
            this.save();
        }
        return this.data;
    }
    ensureBuiltInItems() {
        const modelChanged = this.ensureBuiltInDeepSeekModel();
        const promptChanged = this.ensureBuiltInMcpPrompts();
        return modelChanged || promptChanged;
    }
    ensureBuiltInDeepSeekModel() {
        const now = new Date().toISOString();
        const existing = this.data.models.find((model) => model.id === BUILT_IN_DEEPSEEK_MODEL_ID);
        if (existing) {
            const before = JSON.stringify({
                name: existing.name,
                provider: existing.provider,
                apiUrl: existing.apiUrl,
                isBuiltIn: existing.isBuiltIn,
                status: existing.status
            });
            existing.name = 'DeepSeek';
            existing.provider = 'deepseek';
            existing.apiUrl = 'https://api.deepseek.com';
            existing.isBuiltIn = true;
            existing.updatedAt = now;
            if (!existing.status) {
                existing.status = 'unconfigured';
            }
            const after = JSON.stringify({
                name: existing.name,
                provider: existing.provider,
                apiUrl: existing.apiUrl,
                isBuiltIn: existing.isBuiltIn,
                status: existing.status
            });
            return before !== after;
        }
        this.data.models.unshift({
            id: BUILT_IN_DEEPSEEK_MODEL_ID,
            name: 'DeepSeek',
            provider: 'deepseek',
            apiUrl: 'https://api.deepseek.com',
            apiKey: undefined,
            modelId: undefined,
            isBuiltIn: true,
            status: 'unconfigured',
            createdAt: now,
            updatedAt: now
        });
        return true;
    }
    ensureBuiltInMcpPrompts() {
        const now = new Date().toISOString();
        let changed = false;
        const shouldSyncAllBuiltInPrompts = this.data.config.builtInPromptVersion !== BUILT_IN_PROMPT_VERSION;
        for (const builtInPrompt of BUILT_IN_MCP_PROMPTS) {
            const existing = this.data.prompts.find((item) => item.id === builtInPrompt.id);
            if (existing) {
                if (shouldSyncAllBuiltInPrompts && existing.isBuiltIn) {
                    existing.name = builtInPrompt.name;
                    existing.purpose = builtInPrompt.purpose;
                    existing.content = builtInPrompt.content;
                    existing.isBuiltIn = true;
                    existing.updatedAt = now;
                    changed = true;
                }
                continue;
            }
            this.data.prompts.push({
                ...builtInPrompt,
                createdAt: now,
                updatedAt: now
            });
            changed = true;
        }
        if (this.data.config.builtInPromptVersion !== BUILT_IN_PROMPT_VERSION) {
            this.data.config.builtInPromptVersion = BUILT_IN_PROMPT_VERSION;
            changed = true;
        }
        return changed;
    }
    getSnapshot() {
        return this.data;
    }
    update(mutator) {
        mutator(this.data);
        this.save();
        return this.data;
    }
    // ===== Model Config CRUD =====
    addModel(model) {
        const now = new Date().toISOString();
        const newModel = {
            ...model,
            id: randomUUID(),
            createdAt: now,
            updatedAt: now
        };
        this.data.models.push(newModel);
        this.save();
        return newModel;
    }
    updateModel(id, updates) {
        const index = this.data.models.findIndex(m => m.id === id);
        if (index === -1)
            return null;
        const model = this.data.models[index];
        const updated = {
            ...model,
            ...updates,
            id: model.id,
            createdAt: model.createdAt,
            updatedAt: new Date().toISOString()
        };
        this.data.models[index] = updated;
        this.save();
        return updated;
    }
    getModel(id) {
        return this.data.models.find(m => m.id === id) ?? null;
    }
    getAllModels() {
        return this.data.models;
    }
    deleteModel(id) {
        const index = this.data.models.findIndex(m => m.id === id);
        if (index === -1)
            return false;
        this.data.models.splice(index, 1);
        this.save();
        return true;
    }
    // ===== Prompt Template CRUD =====
    addPrompt(prompt) {
        const now = new Date().toISOString();
        const newPrompt = {
            ...prompt,
            id: randomUUID(),
            createdAt: now,
            updatedAt: now
        };
        this.data.prompts.push(newPrompt);
        this.save();
        return newPrompt;
    }
    updatePrompt(id, updates) {
        const index = this.data.prompts.findIndex(p => p.id === id);
        if (index === -1)
            return null;
        const prompt = this.data.prompts[index];
        const updated = {
            ...prompt,
            ...updates,
            id: prompt.id,
            createdAt: prompt.createdAt,
            updatedAt: new Date().toISOString()
        };
        this.data.prompts[index] = updated;
        this.save();
        return updated;
    }
    getPrompt(id) {
        return this.data.prompts.find(p => p.id === id) ?? null;
    }
    getAllPrompts() {
        return this.data.prompts;
    }
    deletePrompt(id) {
        const index = this.data.prompts.findIndex(p => p.id === id);
        if (index === -1)
            return false;
        this.data.prompts.splice(index, 1);
        this.save();
        return true;
    }
    save() {
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    }
}
