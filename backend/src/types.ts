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
  dailyGrantHour?: number;   // 每日零花钱发放时刻（0-23），默认 8
  dailyGrantMinute?: number; // 每日零花钱发放分钟（0-59），默认 0
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

export interface RobotConfig {
  id: string;
  name: string;
  enabled: boolean;
  childIds: string[];
  controllerOpenIds: string[];
  // 飞书接入凭证（按机器人配置）
  feishuMode?: 'app' | 'webhook';
  feishuWebhookUrl?: string;
  feishuAppId?: string;
  feishuAppSecret?: string;
  feishuVerificationToken?: string;
  feishuSigningSecret?: string;
  feishuDefaultChatId?: string;
  lastActiveChatId?: string;
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
  lastDailyGrantTimes?: Record<string, string>; // childId → 最近一次发放日期 "YYYY-MM-DD"
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
  balance?: number;           // 最近查询到的余额（元）
  balanceCheckedAt?: string;  // 余额最后检查时间
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
  robots: RobotConfig[];
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

// 机器人运行日志（内存，不持久化）
export interface BotLogEntry {
  id: string;
  robotId: string;
  time: string;          // ISO 时间戳
  direction: 'in' | 'out';  // in=收到飞书消息, out=发出飞书消息
  // 收到消息相关
  senderOpenId?: string;
  chatId?: string;
  rawText?: string;      // 原始文本
  intent?: string;       // AI 识别意图
  // 发出消息相关
  messageId?: string;    // 飞书返回的消息 ID
  msgType?: string;      // 消息类型
  cardTitle?: string;    // 卡片标题
  // 结果
  status: 'ok' | 'ignored' | 'failed' | 'unrecognized';
  error?: string;
}
