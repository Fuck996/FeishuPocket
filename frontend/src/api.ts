import { ChildProfile, MoneyTransaction, RobotConfig, UserInfo, WeeklySummary, ModelConfig, PromptTemplate, SystemConfig } from './types';

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

  const responseText = await response.text();
  let json: any;
  try {
    json = responseText ? JSON.parse(responseText) : {};
  } catch {
    const fallbackMessage = responseText.slice(0, 120) || '非 JSON 响应';
    throw new Error(`接口返回格式异常：${fallbackMessage}`);
  }

  if (!response.ok || json.success === false) {
    throw new Error(json.error ?? `请求失败（${response.status}）`);
  }
  return json as T;
}

export async function initAdmin(username: string, password: string): Promise<void> {
  await request('/api/init-admin', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
}

export async function getSetupStatus(): Promise<{ adminInitialized: boolean }> {
  const result = await request<{ success: true; data: { adminInitialized: boolean } }>('/api/setup-status');
  return result.data;
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

export async function createChild(payload: { name: string; avatar?: string; dailyAllowance: number }): Promise<void> {
  await request('/api/children', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function updateChild(childId: string, payload: { name?: string; avatar?: string }): Promise<void> {
  await request(`/api/children/${childId}`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });
}

export async function deleteChild(childId: string): Promise<void> {
  await request(`/api/children/${childId}`, {
    method: 'DELETE'
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

export async function deleteRewardRule(childId: string, keyword: string): Promise<void> {
  await request('/api/config/reward-rule', {
    method: 'DELETE',
    body: JSON.stringify({ childId, keyword })
  });
}

export async function setWeeklyNotify(hour: number, minute: number): Promise<void> {
  await request('/api/config/weekly-notify', {
    method: 'PUT',
    body: JSON.stringify({ hour, minute })
  });
}

export async function getConfig(): Promise<SystemConfig> {
  const result = await request<{ success: true; data: SystemConfig }>('/api/config');
  return result.data;
}

export async function updateSystemConfig(payload: Partial<SystemConfig>): Promise<void> {
  await request('/api/config/system', {
    method: 'PUT',
    body: JSON.stringify(payload)
  });
}

export async function getRobots(): Promise<RobotConfig[]> {
  const result = await request<{ success: true; data: RobotConfig[] }>('/api/robots');
  return result.data;
}

export async function createRobot(payload: {
  name: string;
  enabled: boolean;
  childIds: string[];
  controllerOpenIds: string[];
  allowedChatIds: string[];
}): Promise<RobotConfig> {
  const result = await request<{ success: true; data: RobotConfig }>('/api/robots', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  return result.data;
}

export async function updateRobot(robotId: string, payload: Partial<RobotConfig>): Promise<RobotConfig> {
  const result = await request<{ success: true; data: RobotConfig }>(`/api/robots/${robotId}`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });
  return result.data;
}

export async function deleteRobot(robotId: string): Promise<void> {
  await request(`/api/robots/${robotId}`, {
    method: 'DELETE'
  });
}

export async function getTransactions(): Promise<MoneyTransaction[]> {
  const result = await request<{ success: true; data: MoneyTransaction[] }>('/api/transactions');
  return result.data;
}

export async function getWeeklySummaries(): Promise<WeeklySummary[]> {
  const result = await request<{ success: true; data: WeeklySummary[] }>('/api/weekly-summaries');
  return result.data;
}

// ===== Model Config APIs =====
export async function getModels(): Promise<ModelConfig[]> {
  const result = await request<{ success: true; data: ModelConfig[] }>('/api/models');
  return result.data;
}

export async function createModel(payload: Omit<ModelConfig, 'id' | 'createdAt' | 'updatedAt' | 'status'> & { status?: ModelConfig['status'] }): Promise<ModelConfig> {
  const result = await request<{ success: true; data: ModelConfig }>('/api/models', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  return result.data;
}

export async function discoverModels(provider: ModelConfig['provider'], apiUrl: string, apiKey: string): Promise<string[]> {
  const result = await request<{ success: true; data: string[] }>('/api/models/discover', {
    method: 'POST',
    body: JSON.stringify({ provider, apiUrl, apiKey })
  });
  return result.data;
}

export async function updateModel(id: string, payload: Partial<ModelConfig>): Promise<ModelConfig> {
  const result = await request<{ success: true; data: ModelConfig }>(`/api/models/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });
  return result.data;
}

export async function deleteModel(id: string): Promise<void> {
  await request(`/api/models/${id}`, {
    method: 'DELETE'
  });
}

// ===== Prompt Template APIs =====
export async function getPrompts(): Promise<PromptTemplate[]> {
  const result = await request<{ success: true; data: PromptTemplate[] }>('/api/prompts');
  return result.data;
}

export async function createPrompt(payload: Omit<PromptTemplate, 'id' | 'createdAt' | 'updatedAt'>): Promise<PromptTemplate> {
  const result = await request<{ success: true; data: PromptTemplate }>('/api/prompts', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  return result.data;
}

export async function updatePrompt(id: string, payload: Partial<PromptTemplate>): Promise<PromptTemplate> {
  const result = await request<{ success: true; data: PromptTemplate }>(`/api/prompts/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });
  return result.data;
}

export async function deletePrompt(id: string): Promise<void> {
  await request(`/api/prompts/${id}`, {
    method: 'DELETE'
  });
}
