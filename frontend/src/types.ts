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
  rewardRules: Array<{ id: string; keyword: string; amount: number }>;
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

export interface OperatorUser {
  id: string;
  username: string;
  role: 'admin' | 'operator';
  childIds: string[];
  boundFeishuUserId?: string;
}
