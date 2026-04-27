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
}

export interface AppStore {
  users: UserAccount[];
  children: ChildProfile[];
  transactions: MoneyTransaction[];
  weeklySummaries: WeeklySummary[];
  config: SystemConfig;
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
