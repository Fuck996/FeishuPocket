import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const BUILT_IN_DEEPSEEK_MODEL_ID = 'built-in-deepseek';
const BUILT_IN_PROMPT_VERSION = 'pocket-money-v2';
const BUILT_IN_MCP_PROMPTS = [
    {
        id: 'vscode-chat-report',
        name: '零花钱MCP指令识别',
        purpose: 'pocket-money',
        content: `你是系统内置 MCP 识别引擎。请根据群聊/单聊文本识别并输出指令。\n\n必须支持以下操作：\n1) 调整每日零花钱额度（单位：元）\n2) 设置额外奖励项目与金额（例如：家务 +5 元）\n3) 从零花钱扣除消费金额（允许负数）\n4) 设置每周零花钱统计通知时间\n\n识别约束：\n- 必须屏蔽机器人自身通知消息，避免循环触发\n- 必须识别控制账号身份与绑定小孩关系\n- 控制账号在群聊和单聊发言都可触发\n\n输出要求：\n- 只输出 JSON，不输出解释\n- 字段只允许：intent、childName、amount、rewardKeyword、reason、hour、minute\n- intent 只允许：set_daily_allowance | set_reward_rule | deduct_expense | set_weekly_notify | reward_from_message | unknown`,
        isBuiltIn: true,
        usageCount: 0
    },
    {
        id: 'daily-digest',
        name: '金额变动通知模板',
        purpose: 'daily',
        content: `你是飞书卡片通知生成器。请用于金额变动场景。\n\n当金额增减时，卡片必须包含：\n- 增减/扣除金额\n- 变动原因（默认：发放零花钱；默认扣除：消费；若识别到更准确原因则使用识别结果）\n- 操作对象（小孩）\n- 操作来源（管理员/操作员/机器人/定时任务）\n\n要求：\n- 文案清晰\n- 金额保留两位小数\n- 结果状态明确（成功/失败）`,
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
        content: `你是系统操作反馈通知助手。\n\n以下操作完成后必须回发卡片反馈：\n1) 调整每日额度\n2) 设置额外奖励项目与金额\n3) 设置每周统计通知时间\n\n反馈字段必须包含：\n- 识别结果（成功/失败）\n- 关键参数（对象、金额、时间等）\n- 最终生效值（例如每日零花钱总金额、通知时间）`,
        isBuiltIn: true,
        usageCount: 0
    },
    {
        id: 'optimization-suggestion',
        name: '控制账号触发规则模板',
        purpose: 'optimization',
        content: `你是控制账号与权限规则检查器。\n\n规则要求：\n- 小孩由控制账号绑定管理范围\n- 控制账号在单聊和群聊发言都可触发机器人\n- 未绑定控制账号的消息必须忽略\n- 机器人消息必须忽略，防止循环\n\n请输出执行判断结果与原因。`,
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
        feishuMode: 'app',
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
            robots: parsed.robots ?? [],
            transactions: parsed.transactions ?? [],
            weeklySummaries: parsed.weeklySummaries ?? [],
            models: parsed.models ?? [],
            prompts: parsed.prompts ?? [],
            config: {
                weeklyNotify: parsed.config?.weeklyNotify ?? { hour: 20, minute: 0 },
                ignoreBotUserIds: parsed.config?.ignoreBotUserIds ?? [],
                defaultDailyAllowance: parsed.config?.defaultDailyAllowance ?? 10,
                lastDailyGrantDate: parsed.config?.lastDailyGrantDate,
                feishuMode: parsed.config?.feishuMode ?? 'app',
                feishuWebhookUrl: parsed.config?.feishuWebhookUrl,
                feishuAppId: parsed.config?.feishuAppId,
                feishuAppSecret: parsed.config?.feishuAppSecret,
                feishuVerificationToken: parsed.config?.feishuVerificationToken,
                feishuSigningSecret: parsed.config?.feishuSigningSecret,
                feishuDefaultChatId: parsed.config?.feishuDefaultChatId,
                lastActiveChatId: parsed.config?.lastActiveChatId,
                builtInPromptVersion: parsed.config?.builtInPromptVersion
            }
        };
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
