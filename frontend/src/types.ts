export interface UserInfo {
  id: string;
  username: string;
  role: 'admin' | 'operator';
  boundFeishuUserId?: string;
  childIds: string[];
}

export interface ChildProfile {
  id: string;
  name: string;
  avatar: string;
  balance: number;
  dailyAllowance: number;
  dailyGrantHour?: number;
  dailyGrantMinute?: number;
  rewardRules: Array<{ id: string; keyword: string; amount: number }>;
}

export interface MoneyTransaction {
  id: string;
  childId: string;
  amount: number;
  reason: string;
  type: 'daily' | 'reward' | 'expense' | 'manual';
  source: 'admin' | 'operator' | 'bot' | 'schedule' | 'mcp';
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
}

export interface RobotConfig {
  id: string;
  name: string;
  enabled: boolean;
  childIds: string[];
  controllerOpenIds: string[];
  allowedChatIds: string[];
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

export interface SystemConfig {
  weeklyNotify: {
    hour: number;
    minute: number;
  };
  ignoreBotUserIds: string[];
  defaultDailyAllowance: number;
}

export type ModelProvider = 'openai' | 'deepseek' | 'google' | 'custom';

export interface ModelConfig {
  id: string;
  name: string;
  provider: ModelProvider;
  apiUrl: string;
  apiKey?: string;
  hasApiKey?: boolean;
  modelId?: string;
  isBuiltIn: boolean;
  status: 'connected' | 'testing' | 'disconnected' | 'unconfigured';
  lastTestedAt?: string;
  balance?: number;
  balanceCheckedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PromptTemplate {
  id: string;
  name: string;
  purpose: 'pocket-money' | 'vscode-chat' | 'daily' | 'weekly' | 'incident' | 'optimization' | 'custom';
  content: string;
  isBuiltIn: boolean;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}
