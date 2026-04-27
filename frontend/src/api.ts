import { ChildProfile, OperatorUser, UserInfo, WeeklySummary } from './types';

const TOKEN_KEY = 'fp_token';

function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers ?? {});
  headers.set('Content-Type', 'application/json');
  const token = getToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(url, {
    ...options,
    headers
  });

  const json = await response.json();
  if (!response.ok || json.success === false) {
    throw new Error(json.error ?? '请求失败');
  }
  return json as T;
}

export async function initAdmin(username: string, password: string): Promise<void> {
  await request('/api/init-admin', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
}

export async function login(username: string, password: string): Promise<UserInfo> {
  const result = await request<{ success: true; token: string; user: UserInfo }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
  setToken(result.token);
  return result.user;
}

export async function me(): Promise<UserInfo> {
  const result = await request<{ success: true; user: UserInfo }>('/api/auth/me');
  return result.user;
}

export function logout(): void {
  clearToken();
}

export async function bindFeishu(feishuUserId: string): Promise<void> {
  await request('/api/auth/bind-feishu', {
    method: 'POST',
    body: JSON.stringify({ feishuUserId })
  });
}

export async function getChildren(): Promise<ChildProfile[]> {
  const result = await request<{ success: true; data: ChildProfile[] }>('/api/children');
  return result.data;
}

export async function createChild(payload: { name: string; avatar: string; dailyAllowance: number }): Promise<void> {
  await request('/api/children', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function adjustChild(childId: string, payload: { amount: number; reason: string }): Promise<void> {
  await request(`/api/children/${childId}/adjust`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function setDailyAllowance(childId: string, amount: number): Promise<void> {
  await request('/api/config/daily-allowance', {
    method: 'PUT',
    body: JSON.stringify({ childId, amount })
  });
}

export async function setRewardRule(childId: string, keyword: string, amount: number): Promise<void> {
  await request('/api/config/reward-rule', {
    method: 'PUT',
    body: JSON.stringify({ childId, keyword, amount })
  });
}

export async function setWeeklyNotify(hour: number, minute: number): Promise<void> {
  await request('/api/config/weekly-notify', {
    method: 'PUT',
    body: JSON.stringify({ hour, minute })
  });
}

export async function getOperators(): Promise<OperatorUser[]> {
  const result = await request<{ success: true; data: OperatorUser[] }>('/api/operators');
  return result.data;
}

export async function createOperator(payload: { username: string; password: string; childIds: string[] }): Promise<void> {
  await request('/api/operators', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function updateOperator(userId: string, payload: { childIds: string[]; boundFeishuUserId: string }): Promise<void> {
  await request(`/api/operators/${userId}`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });
}

export async function getTransactions(): Promise<Array<{ id: string; childId: string; amount: number; reason: string; createdAt: string }>> {
  const result = await request<{ success: true; data: Array<{ id: string; childId: string; amount: number; reason: string; createdAt: string }> }>('/api/transactions');
  return result.data;
}

export async function getWeeklySummaries(): Promise<WeeklySummary[]> {
  const result = await request<{ success: true; data: WeeklySummary[] }>('/api/weekly-summaries');
  return result.data;
}
