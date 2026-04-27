export type UserRole = 'admin' | 'operator';

export interface RewardRule {
  id: string;
  keyword: string;
  amount: number;
  createdAt: string;
}

export interface ChildProfile {
  id: string;
  name: string;
  avatar: string;
  balance: number;
  dailyAllowance: number;
  rewardRules: RewardRule[];
  createdAt: string;
  updatedAt: string;
}

export interface UserAccount {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  boundFeishuUserId?: string;
  childIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MoneyTransaction {
  id: string;
  childId: string;
  amount: number;
  reason: string;
  type: 'daily' | 'reward' | 'expense' | 'manual';
  source: 'admin' | 'operator' | 'bot' | 'schedule' | 'mcp';
  actorUserId?: string;
  createdAt: string;
}

export interface WeeklySummary {
  id: string;
  childId: string;
  weekStartDate: string;
  weekEndDate: string;
  increasedAmount: number;
  expenseAmount: number;
  remainingAmount: number;
  maxExpenseReason: string;
  maxExpenseAmount: number;
  aiSuggestion: string;
  createdAt: string;
}

export interface WeeklyNotifyConfig {
  hour: number;
  minute: number;
}

export interface SystemConfig {
  weeklyNotify: WeeklyNotifyConfig;
  ignoreBotUserIds: string[];
  defaultDailyAllowance: number;
  lastDailyGrantDate?: string;
  // 飞书机器人配置（支持自建应用机器人与群 webhook 两种模式）
  feishuMode?: 'app' | 'webhook';
  feishuWebhookUrl?: string;
  feishuAppId?: string;
  feishuAppSecret?: string;
  feishuVerificationToken?: string;
  feishuSigningSecret?: string;
  feishuDefaultChatId?: string;
  lastActiveChatId?: string;
  builtInPromptVersion?: string;
}

export type ModelProvider = 'openai' | 'deepseek' | 'google' | 'custom';

export interface ModelConfig {
  id: string;
  name: string; // 配置名称
  provider: ModelProvider; // 模型服务商
  apiUrl: string; // API 基础地址
  apiKey?: string; // API Key (不存储)
  hasApiKey?: boolean; // 返回前端时的脱敏标记
  modelId?: string; // 已选择的模型 ID
  isBuiltIn: boolean; // 是否推荐模型
  status: 'connected' | 'testing' | 'disconnected' | 'unconfigured'; // 连接状态
  lastTestedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PromptTemplate {
  id: string;
  name: string; // 模板名称
  purpose: 'pocket-money' | 'vscode-chat' | 'daily' | 'weekly' | 'incident' | 'optimization' | 'custom'; // 用途
  content: string; // 模板内容
  isBuiltIn: boolean; // 是否内置模板
  usageCount: number; // 使用次数
  createdAt: string;
  updatedAt: string;
}

export interface AppStore {
  users: UserAccount[];
  children: ChildProfile[];
  transactions: MoneyTransaction[];
  weeklySummaries: WeeklySummary[];
  config: SystemConfig;
  models: ModelConfig[];
  prompts: PromptTemplate[];
}

export interface ParsedBotAction {
  intent: 'set_daily_allowance' | 'set_reward_rule' | 'deduct_expense' | 'set_weekly_notify' | 'reward_from_message' | 'unknown';
  childName?: string;
  amount?: number;
  rewardKeyword?: string;
  reason?: string;
  hour?: number;
  minute?: number;
}
