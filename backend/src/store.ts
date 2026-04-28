import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { AppStore, ModelConfig, PromptTemplate } from './types.js';

const BUILT_IN_DEEPSEEK_MODEL_ID = 'built-in-deepseek';
const BUILT_IN_PROMPT_VERSION = 'pocket-money-v11';

const BUILT_IN_MCP_PROMPTS: Array<Omit<PromptTemplate, 'createdAt' | 'updatedAt'>> = [
  {
    id: 'vscode-chat-report',
    name: '零花钱MCP指令识别',
    purpose: 'pocket-money',
    content: `你是零花钱指令识别引擎。请根据群聊/单聊文本识别并输出指令。\n\n处理顺序（必须遵守）：\n第一步：优先匹配精确指令（格式正确即执行，不依赖 AI）\n- 控制台\n- 发放零花钱（表示立刻发放今日零花钱）\n- 余额增加：n（中英文冒号都可）\n- 余额减少：n（中英文冒号都可）\n- 查询余额 / 余额\n- 周统计\n- 月统计\n- 帮助 / 指令 / 说明\n\n第二步：若不属于精确指令，再走 AI 识别自然语言，主要用于消费、奖励和余额增减相关对话。\n\n第三步：精确指令和 AI 都未识别时，返回 unknown。\n\n小孩与控制账号绑定关系已由机器人配置确定，不需要 AI 识别 childName。\n\nAI 路径必须支持的操作：\n1) 调整每日零花钱额度（单位：元）\n2) 设置额外奖励项目与金额（例如：家务 +5 元）\n3) 从零花钱扣除消费金额（识别时 amount 一律输出正数）\n4) 设置每周零花钱统计通知时间\n5) 识别“完成某项目”或“因为某原因奖励 n 元”触发奖励（reward_from_message）\n6) 查询余额（query_balance）\n7) 增加余额（increase_balance）\n8) 减少余额（decrease_balance）\n\n口语化兼容示例：\n- “每天改12”\n- “配个家务奖励5块”\n- “今天买文具花了18”\n- “完成了家务”\n- “表现良好，奖励5元”\n- “家务完成，奖励3元”\n- “增加5元，因为表现良好”\n- “减少5元，因为录入错误”\n- “查询余额”\n\n识别约束：\n- 必须屏蔽机器人自身通知消息，避免循环触发\n- 控制账号在群聊和单聊发言都可触发\n- 信息不足或冲突时返回 unknown\n\n输出要求：\n- 只输出 JSON，不输出触发者身份判断或触发原因分析\n- 字段只允许：intent、amount、rewardKeyword、reason、hour、minute\n- reward_from_message 若用户原话明确给出金额，amount 必须一并返回\n- reward_from_message 的 reason 直接返回本次变动原因，不要求匹配系统已配置奖励项目\n- intent 只允许：set_daily_allowance | set_reward_rule | deduct_expense | set_weekly_notify | reward_from_message | query_balance | increase_balance | decrease_balance | unknown`,
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

const DEFAULT_STORE: AppStore = {
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
    processedMessageIds: [],
    defaultDailyAllowance: 10,
    builtInPromptVersion: BUILT_IN_PROMPT_VERSION
  }
};

export class JsonStore {
  private readonly filePath: string;
  private data: AppStore = structuredClone(DEFAULT_STORE);

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  public load(): AppStore {
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
    const parsed = JSON.parse(raw) as Partial<AppStore>;
    this.data = {
      users: parsed.users ?? [],
      children: (parsed.children ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        avatar: c.avatar ?? '',
        feishuAvatarKey: c.feishuAvatarKey,
        feishuAvatarSource: c.feishuAvatarSource,
        balance: c.balance ?? 0,
        dailyAllowance: c.dailyAllowance ?? (parsed.config?.defaultDailyAllowance ?? 10),
        dailyGrantHour: c.dailyGrantHour,
        dailyGrantMinute: c.dailyGrantMinute,
        rewardRules: c.rewardRules ?? [],
        createdAt: c.createdAt,
        updatedAt: c.updatedAt
      })),
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
        menuBridgeBaseUrl: typeof r.menuBridgeBaseUrl === 'string' ? r.menuBridgeBaseUrl.trim() : undefined,
        menuBridgeTokens: (r.menuBridgeTokens && typeof r.menuBridgeTokens === 'object')
          ? Object.fromEntries(
              Object.entries(r.menuBridgeTokens as Record<string, unknown>)
                .map(([chatId, token]) => [String(chatId).trim(), String(token ?? '').trim()])
                .filter(([chatId, token]) => Boolean(chatId && token))
            )
          : {},
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
        processedMessageIds: parsed.config?.processedMessageIds ?? [],
        defaultDailyAllowance: parsed.config?.defaultDailyAllowance ?? 10,
        lastDailyGrantDate: parsed.config?.lastDailyGrantDate,
        lastDailyGrantTimes: parsed.config?.lastDailyGrantTimes ?? {},
        builtInPromptVersion: parsed.config?.builtInPromptVersion
      }
    };

    // 兼容旧版本迁移：将全局飞书配置迁移到第一个机器人
    const oldCfg = parsed.config as Record<string, unknown> | undefined;
    if (oldCfg?.feishuAppId || oldCfg?.feishuWebhookUrl) {
      const firstRobot = this.data.robots[0];
      if (firstRobot && !firstRobot.feishuAppId && !firstRobot.feishuWebhookUrl) {
        firstRobot.feishuMode = (oldCfg.feishuMode as 'app' | 'webhook' | undefined) ?? 'app';
        firstRobot.feishuAppId = oldCfg.feishuAppId as string | undefined;
        firstRobot.feishuAppSecret = oldCfg.feishuAppSecret as string | undefined;
        firstRobot.feishuWebhookUrl = oldCfg.feishuWebhookUrl as string | undefined;
        firstRobot.feishuVerificationToken = oldCfg.feishuVerificationToken as string | undefined;
        firstRobot.feishuSigningSecret = oldCfg.feishuSigningSecret as string | undefined;
        firstRobot.feishuDefaultChatId = oldCfg.feishuDefaultChatId as string | undefined;
        firstRobot.lastActiveChatId = oldCfg.lastActiveChatId as string | undefined;
      }
    }

    // 增量补齐内置模型与提示词，避免破坏已有用户数据。
    const changed = this.ensureBuiltInItems();
    if (changed) {
      this.save();
    }
    return this.data;
  }

  private ensureBuiltInItems(): boolean {
    const modelChanged = this.ensureBuiltInDeepSeekModel();
    const promptChanged = this.ensureBuiltInMcpPrompts();
    return modelChanged || promptChanged;
  }

  private ensureBuiltInDeepSeekModel(): boolean {
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

  private ensureBuiltInMcpPrompts(): boolean {
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

  public getSnapshot(): AppStore {
    return this.data;
  }

  public update(mutator: (draft: AppStore) => void): AppStore {
    mutator(this.data);
    this.save();
    return this.data;
  }

  // ===== Model Config CRUD =====
  public addModel(model: Omit<ModelConfig, 'id' | 'createdAt' | 'updatedAt'>): ModelConfig {
    const now = new Date().toISOString();
    const newModel: ModelConfig = {
      ...model,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now
    };
    this.data.models.push(newModel);
    this.save();
    return newModel;
  }

  public updateModel(id: string, updates: Partial<ModelConfig>): ModelConfig | null {
    const index = this.data.models.findIndex(m => m.id === id);
    if (index === -1) return null;
    
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

  public getModel(id: string): ModelConfig | null {
    return this.data.models.find(m => m.id === id) ?? null;
  }

  public getAllModels(): ModelConfig[] {
    return this.data.models;
  }

  public deleteModel(id: string): boolean {
    const index = this.data.models.findIndex(m => m.id === id);
    if (index === -1) return false;
    
    this.data.models.splice(index, 1);
    this.save();
    return true;
  }

  // ===== Prompt Template CRUD =====
  public addPrompt(prompt: Omit<PromptTemplate, 'id' | 'createdAt' | 'updatedAt'>): PromptTemplate {
    const now = new Date().toISOString();
    const newPrompt: PromptTemplate = {
      ...prompt,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now
    };
    this.data.prompts.push(newPrompt);
    this.save();
    return newPrompt;
  }

  public updatePrompt(id: string, updates: Partial<PromptTemplate>): PromptTemplate | null {
    const index = this.data.prompts.findIndex(p => p.id === id);
    if (index === -1) return null;
    
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

  public getPrompt(id: string): PromptTemplate | null {
    return this.data.prompts.find(p => p.id === id) ?? null;
  }

  public getAllPrompts(): PromptTemplate[] {
    return this.data.prompts;
  }

  public deletePrompt(id: string): boolean {
    const index = this.data.prompts.findIndex(p => p.id === id);
    if (index === -1) return false;
    
    this.data.prompts.splice(index, 1);
    this.save();
    return true;
  }

  private save(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }
}
