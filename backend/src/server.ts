import 'dotenv/config';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import { nanoid } from 'nanoid';

import { comparePassword, hashPassword, signToken, verifyToken } from './auth.js';
import { parseBotAction } from './aiParser.js';
import { sendFeishuCard } from './feishu.js';
import { SchedulerService } from './scheduler.js';
import { JsonStore } from './store.js';
import { checkAllModelBalances } from './modelBalance.js';
import { ChildProfile, MoneyTransaction, ParsedBotAction, UserAccount, UserRole, WeeklySummary, ModelConfig, ModelProvider, PromptTemplate } from './types.js';

type AuthedRequest = Request & {
  authUser?: UserAccount;
  rawBody?: string;
};

type FeishuSendTarget = {
  mode: 'app' | 'webhook';
  webhookUrl?: string;
  appId?: string;
  appSecret?: string;
  chatId?: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3000);

// JWT Secret 完全自动化处理
// 优先级：持久化文件 > 首次启动自动生成
// 无需环保变量配置，容器重启后密钥保持不变
function initializeJwtSecret(): string {
  const jwtSecretPath = path.resolve(__dirname, '../data/.jwt-secret');
  
  // 1. 读取持久化文件（容器重启时复用）
  try {
    if (fs.existsSync(jwtSecretPath)) {
      const secret = fs.readFileSync(jwtSecretPath, 'utf-8').trim();
      console.log('[Init] Loaded persisted JWT secret from .jwt-secret');
      return secret;
    }
  } catch (error) {
    console.warn('[Warn] Failed to read .jwt-secret file:', error);
  }
  
  // 2. 首次启动，自动生成新密钥
  try {
    const secret = crypto.randomBytes(32).toString('base64');
    fs.mkdirSync(path.dirname(jwtSecretPath), { recursive: true });
    fs.writeFileSync(jwtSecretPath, secret, { mode: 0o600 });
    console.log('[Init] Generated new JWT secret and persisted to .jwt-secret');
    return secret;
  } catch (error) {
    console.error('[ERROR] Failed to generate JWT secret:', error);
    // 紧急兜底方案（仅在持久化失败时使用）
    const fallback = 'fallback-' + crypto.randomBytes(16).toString('hex');
    console.warn('[ERROR] Using temporary fallback secret, tokens may not persist across restarts');
    return fallback;
  }
}

const jwtSecret = initializeJwtSecret();

const databasePath = process.env.DATABASE_PATH ?? path.resolve(__dirname, '../data/store.json');
const frontendDistPath = path.resolve(__dirname, '../public');

const store = new JsonStore(databasePath);
store.load();

app.use(cors());
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buffer) => {
    (req as AuthedRequest).rawBody = buffer.toString('utf8');
  }
}));

// 一体化部署时由后端托管前端静态文件。
if (fs.existsSync(frontendDistPath)) {
  app.use(express.static(frontendDistPath));
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyFeishuToken(body: unknown): boolean {
  const verifyToken = store.getSnapshot().config.feishuVerificationToken ?? process.env.FEISHU_VERIFICATION_TOKEN;
  if (!verifyToken) {
    return true;
  }

  const payload = body as { token?: string; header?: { token?: string } };
  const tokenInBody = payload?.header?.token ?? payload?.token;
  if (!tokenInBody) {
    return false;
  }
  return safeEqual(verifyToken, tokenInBody);
}

function verifyFeishuSignature(req: AuthedRequest): boolean {
  const secret = store.getSnapshot().config.feishuSigningSecret ?? process.env.FEISHU_SIGNING_SECRET;
  if (!secret) {
    return true;
  }

  const timestamp = req.header('x-lark-request-timestamp') ?? req.header('X-Lark-Request-Timestamp');
  const nonce = req.header('x-lark-request-nonce') ?? req.header('X-Lark-Request-Nonce');
  const signature = req.header('x-lark-signature') ?? req.header('X-Lark-Signature');
  const rawBody = req.rawBody ?? '';

  if (!timestamp || !nonce || !signature) {
    return false;
  }

  const plain = `${timestamp}${nonce}${rawBody}`;
  const base64Sign = crypto.createHmac('sha256', secret).update(plain).digest('base64');
  const hexSign = crypto.createHmac('sha256', secret).update(plain).digest('hex');
  const withPrefix = `sha256=${hexSign}`;

  return safeEqual(signature, base64Sign) || safeEqual(signature, hexSign) || safeEqual(signature, withPrefix);
}

function extractFeishuEvent(reqBody: unknown): {
  senderOpenId?: string;
  senderType?: string;
  messageType?: string;
  contentRaw?: string;
  chatId?: string;
} {
  const body = reqBody as Record<string, unknown>;
  const event = (body.event as Record<string, unknown> | undefined) ?? body;
  const sender = (event.sender as Record<string, unknown> | undefined) ?? {};
  const senderId = (sender.sender_id as Record<string, unknown> | undefined) ?? {};
  const message = (event.message as Record<string, unknown> | undefined) ?? (body.message as Record<string, unknown> | undefined) ?? {};

  const senderOpenId =
    (senderId.open_id as string | undefined) ??
    (sender.open_id as string | undefined) ??
    ((event.operator as Record<string, unknown> | undefined)?.open_id as string | undefined) ??
    (body.open_id as string | undefined);

  const senderType = (sender.sender_type as string | undefined) ?? (sender.type as string | undefined);
  const messageType = (message.message_type as string | undefined) ?? (message.type as string | undefined);
  const chatId = (message.chat_id as string | undefined) ?? ((event.chat as Record<string, unknown> | undefined)?.chat_id as string | undefined);
  const contentField = message.content;

  let contentRaw: string | undefined;
  if (typeof contentField === 'string') {
    contentRaw = contentField;
  } else if (contentField && typeof contentField === 'object') {
    contentRaw = JSON.stringify(contentField);
  } else if (typeof body.content === 'string') {
    contentRaw = body.content;
  }

  return {
    senderOpenId,
    senderType,
    messageType,
    contentRaw,
    chatId
  };
}

function resolveFeishuSendTarget(chatIdOverride?: string): FeishuSendTarget {
  const config = store.getSnapshot().config;
  const mode = config.feishuMode ?? 'app';
  const resolvedChatId = chatIdOverride ?? config.feishuDefaultChatId ?? config.lastActiveChatId;

  if (mode === 'webhook') {
    return {
      mode,
      webhookUrl: config.feishuWebhookUrl
    };
  }

  return {
    mode,
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    chatId: resolvedChatId,
    webhookUrl: config.feishuWebhookUrl
  };
}

async function sendRobotCard(payload: { title: string; lines: string[] }, chatIdOverride?: string): Promise<void> {
  await sendFeishuCard(resolveFeishuSendTarget(chatIdOverride), payload);
}

function sanitizeUser(user: UserAccount) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    boundFeishuUserId: user.boundFeishuUserId,
    childIds: user.childIds
  };
}

function findUserById(userId: string): UserAccount | undefined {
  return store.getSnapshot().users.find((item) => item.id === userId);
}

function findChildById(childId: string): ChildProfile | undefined {
  return store.getSnapshot().children.find((item) => item.id === childId);
}

function canManageChild(user: UserAccount, childId: string): boolean {
  if (user.role === 'admin') {
    return true;
  }
  return user.childIds.includes(childId);
}

function amountYuan(value: number): string {
  return `${value.toFixed(2)}元`;
}

function inferSuggestion(increasedAmount: number, expenseAmount: number, remainingAmount: number): string {
  if (increasedAmount === 0 && expenseAmount === 0) {
    return '本周无有效记账记录，建议先从每天记录1笔小额消费开始。';
  }

  const ratio = increasedAmount === 0 ? 1 : expenseAmount / increasedAmount;
  if (ratio > 0.9) {
    return '本周消费接近全部零花钱，建议下周设置每周消费上限并提前规划。';
  }
  if (remainingAmount > increasedAmount * 0.6) {
    return '本周结余较高，可以设立一个小目标，把结余分成储蓄和奖励两部分。';
  }
  return '本周消费与收入较平衡，建议继续保持，并记录高频消费原因。';
}

function normalizeApiUrl(provider: ModelProvider, apiUrl: string): string {
  const trimmed = apiUrl.trim().replace(/\/+$/, '');

  if ((provider === 'deepseek' || provider === 'openai') && trimmed.endsWith('/v1')) {
    return trimmed.slice(0, -3);
  }

  return trimmed;
}

function buildModelListEndpoint(provider: ModelProvider, apiUrl: string): string {
  const normalized = normalizeApiUrl(provider, apiUrl);

  if (provider === 'google') {
    return `${normalized}/v1beta/models`;
  }

  if (provider === 'deepseek' || provider === 'openai') {
    return `${normalized}/v1/models`;
  }

  return `${normalized}/models`;
}

async function discoverProviderModels(provider: ModelProvider, apiUrl: string, apiKey: string): Promise<string[]> {
  const endpoint = buildModelListEndpoint(provider, apiUrl);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };

  if (provider === 'google') {
    headers['x-goog-api-key'] = apiKey;
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(endpoint, { method: 'GET', headers });
  if (!response.ok) {
    throw new Error(`模型列表获取失败 (${response.status})`);
  }

  const data = (await response.json()) as {
    data?: Array<{ id?: string }>;
    models?: Array<{ name?: string }>;
  };

  const list = provider === 'google'
    ? (data.models ?? []).map((item) => String(item.name ?? '').replace(/^models\//, '').trim())
    : (data.data ?? []).map((item) => String(item.id ?? '').trim());

  return Array.from(new Set(list.filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function resolveParserModelConfig(): { apiKey?: string; apiUrl?: string; modelId?: string } {
  const models = store.getAllModels();

  const preferredDeepSeek = models.find((item) =>
    item.provider === 'deepseek' && item.isBuiltIn && item.apiKey && item.modelId
  );
  if (preferredDeepSeek) {
    return {
      apiKey: preferredDeepSeek.apiKey,
      apiUrl: normalizeApiUrl(preferredDeepSeek.provider, preferredDeepSeek.apiUrl),
      modelId: preferredDeepSeek.modelId
    };
  }

  const fallback = models.find((item) => item.apiKey && item.modelId);
  if (fallback) {
    return {
      apiKey: fallback.apiKey,
      apiUrl: normalizeApiUrl(fallback.provider, fallback.apiUrl),
      modelId: fallback.modelId
    };
  }

  return {
    apiKey: process.env.OPENAI_API_KEY,
    apiUrl: process.env.OPENAI_BASE_URL,
    modelId: process.env.OPENAI_MODEL
  };
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: '未授权' });
    return;
  }

  const token = authHeader.replace('Bearer ', '');
  try {
    const payload = verifyToken(jwtSecret, token);
    const user = findUserById(payload.userId);
    if (!user) {
      res.status(401).json({ success: false, error: '用户不存在' });
      return;
    }
    req.authUser = user;
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Token 无效' });
  }
}

function requireRole(role: UserRole) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.authUser) {
      res.status(401).json({ success: false, error: '未授权' });
      return;
    }
    if (req.authUser.role !== role) {
      res.status(403).json({ success: false, error: '无权限' });
      return;
    }
    next();
  };
}

async function applyTransaction(input: {
  childId: string;
  amount: number;
  reason: string;
  type: MoneyTransaction['type'];
  source: MoneyTransaction['source'];
  actorUserId?: string;
}): Promise<{ child: ChildProfile; transaction: MoneyTransaction }> {
  const snapshot = store.getSnapshot();
  const child = snapshot.children.find((item) => item.id === input.childId);
  if (!child) {
    throw new Error('小孩不存在');
  }

  const transaction: MoneyTransaction = {
    id: nanoid(),
    childId: input.childId,
    amount: input.amount,
    reason: input.reason,
    type: input.type,
    source: input.source,
    actorUserId: input.actorUserId,
    createdAt: new Date().toISOString()
  };

  store.update((draft) => {
    const targetChild = draft.children.find((item) => item.id === input.childId);
    if (!targetChild) {
      return;
    }
    targetChild.balance += input.amount;
    targetChild.updatedAt = new Date().toISOString();
    draft.transactions.push(transaction);
  });

  // 从数据库读取飞书 webhook，而非环境变量
  await sendRobotCard({
    title: '零花钱金额变动通知',
    lines: [
      `**对象**：${child.name}`,
      `**金额**：${input.amount > 0 ? '+' : ''}${amountYuan(input.amount)}`,
      `**原因**：${input.reason}`,
      `**来源**：${input.source}`
    ]
  });

  const updated = findChildById(input.childId);
  if (!updated) {
    throw new Error('小孩数据异常');
  }
  return { child: updated, transaction };
}

function getDefaultChildForUser(user: UserAccount): ChildProfile | undefined {
  const snapshot = store.getSnapshot();
  if (user.role === 'admin') {
    return snapshot.children[0];
  }
  const firstId = user.childIds[0];
  if (!firstId) {
    return undefined;
  }
  return snapshot.children.find((item) => item.id === firstId);
}

function resolveChildFromAction(action: ParsedBotAction, user: UserAccount): ChildProfile | undefined {
  const snapshot = store.getSnapshot();
  if (action.childName) {
    const found = snapshot.children.find((item) => item.name === action.childName);
    if (!found) {
      return undefined;
    }
    if (!canManageChild(user, found.id)) {
      return undefined;
    }
    return found;
  }
  return getDefaultChildForUser(user);
}

async function runDailyGrant(): Promise<void> {
  const snapshot = store.getSnapshot();
  const today = new Date().toISOString().slice(0, 10);
  if (snapshot.config.lastDailyGrantDate === today) {
    return;
  }

  for (const child of snapshot.children) {
    await applyTransaction({
      childId: child.id,
      amount: child.dailyAllowance,
      reason: '发放每日零花钱',
      type: 'daily',
      source: 'schedule'
    });
  }

  store.update((draft) => {
    draft.config.lastDailyGrantDate = today;
  });
}

function getLastWeekRange(): { start: Date; end: Date; startText: string; endText: string } {
  const now = new Date();
  const day = now.getDay();
  const offsetToMonday = day === 0 ? 6 : day - 1;

  const start = new Date(now);
  start.setDate(now.getDate() - offsetToMonday - 7);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);

  return {
    start,
    end,
    startText: start.toISOString().slice(0, 10),
    endText: end.toISOString().slice(0, 10)
  };
}

async function runWeeklySummary(): Promise<void> {
  const snapshot = store.getSnapshot();
  const range = getLastWeekRange();

  for (const child of snapshot.children) {
    const records = snapshot.transactions.filter((item) => {
      if (item.childId !== child.id) {
        return false;
      }
      const time = new Date(item.createdAt).getTime();
      return time >= range.start.getTime() && time <= range.end.getTime();
    });

    const increasedAmount = records.filter((item) => item.amount > 0).reduce((sum, item) => sum + item.amount, 0);
    const expenseAmount = records.filter((item) => item.amount < 0).reduce((sum, item) => sum + Math.abs(item.amount), 0);

    const expenseRecords = records.filter((item) => item.amount < 0).sort((a, b) => a.amount - b.amount);
    const maxExpense = expenseRecords[0];

    const aiSuggestion = inferSuggestion(increasedAmount, expenseAmount, child.balance);

    const summary: WeeklySummary = {
      id: nanoid(),
      childId: child.id,
      weekStartDate: range.startText,
      weekEndDate: range.endText,
      increasedAmount,
      expenseAmount,
      remainingAmount: child.balance,
      maxExpenseReason: maxExpense?.reason ?? '无',
      maxExpenseAmount: maxExpense ? Math.abs(maxExpense.amount) : 0,
      aiSuggestion,
      createdAt: new Date().toISOString()
    };

    store.update((draft) => {
      draft.weeklySummaries.push(summary);
    });

    await sendRobotCard({
      title: `${child.name}上周零花钱统计`,
      lines: [
        `**统计周期**：${range.startText} ~ ${range.endText}`,
        `**总增加金额**：${amountYuan(increasedAmount)}`,
        `**消费金额**：${amountYuan(expenseAmount)}`,
        `**剩余金额**：${amountYuan(child.balance)}`,
        `**最大消费项目**：${summary.maxExpenseReason}（${amountYuan(summary.maxExpenseAmount)}）`,
        `**AI建议**：${summary.aiSuggestion}`
      ]
    });
  }
}

async function checkModelBalances(): Promise<void> {
  try {
    await checkAllModelBalances();
  } catch (error) {
    console.error('[Scheduler] Error checking model balances:', error);
  }
}

const snapshot = store.getSnapshot();
const scheduler = new SchedulerService(
  {
    runDailyGrant,
    runWeeklySummary,
    checkModelBalances
  },
  snapshot.config.weeklyNotify.hour,
  snapshot.config.weeklyNotify.minute
);

app.get('/api/version', (_req, res) => {
  res.json({ success: true, version: '0.2.1' });
});

app.get('/api/setup-status', (_req, res) => {
  const adminInitialized = store.getSnapshot().users.some((item) => item.role === 'admin');
  res.json({ success: true, data: { adminInitialized } });
});

app.post('/api/init-admin', async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  const normalizedUsername = username?.trim();
  const normalizedPassword = password ?? '';

  if (!normalizedUsername || !normalizedPassword) {
    res.status(400).json({ success: false, error: '用户名和密码必填' });
    return;
  }

  if (store.getSnapshot().users.some((item) => item.role === 'admin')) {
    res.status(400).json({ success: false, error: '管理员已初始化' });
    return;
  }

  const now = new Date().toISOString();
  const admin: UserAccount = {
    id: nanoid(),
    username: normalizedUsername,
    passwordHash: await hashPassword(normalizedPassword),
    role: 'admin',
    childIds: [],
    createdAt: now,
    updatedAt: now
  };

  store.update((draft) => {
    draft.users.push(admin);
  });

  res.json({ success: true, message: '管理员初始化成功' });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  const normalizedUsername = username?.trim();
  const normalizedPassword = password ?? '';

  if (!normalizedUsername || !normalizedPassword) {
    res.status(400).json({ success: false, error: '用户名和密码必填' });
    return;
  }

  const user = store.getSnapshot().users.find((item) => item.username === normalizedUsername);
  if (!user) {
    res.status(401).json({ success: false, error: '账号或密码错误' });
    return;
  }

  const matched = await comparePassword(normalizedPassword, user.passwordHash);
  if (!matched) {
    res.status(401).json({ success: false, error: '账号或密码错误' });
    return;
  }

  const token = signToken(jwtSecret, user);
  res.json({ success: true, token, user: sanitizeUser(user) });
});

app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
  res.json({ success: true, user: sanitizeUser(req.authUser as UserAccount) });
});

app.post('/api/auth/bind-feishu', requireAuth, (req: AuthedRequest, res) => {
  const { feishuUserId } = req.body as { feishuUserId?: string };
  if (!feishuUserId) {
    res.status(400).json({ success: false, error: 'feishuUserId 必填' });
    return;
  }

  store.update((draft) => {
    const user = draft.users.find((item) => item.id === req.authUser?.id);
    if (!user) {
      return;
    }
    user.boundFeishuUserId = feishuUserId;
    user.updatedAt = new Date().toISOString();
  });

  res.json({ success: true, message: '飞书账号绑定成功' });
});

app.get('/api/children', requireAuth, (req: AuthedRequest, res) => {
  const user = req.authUser as UserAccount;
  const list = user.role === 'admin'
    ? store.getSnapshot().children
    : store.getSnapshot().children.filter((item) => user.childIds.includes(item.id));
  res.json({ success: true, data: list });
});

app.post('/api/children', requireAuth, requireRole('admin'), (req, res) => {
  const { name, avatar, dailyAllowance } = req.body as { name?: string; avatar?: string; dailyAllowance?: number };
  if (!name) {
    res.status(400).json({ success: false, error: '姓名必填' });
    return;
  }

  const now = new Date().toISOString();
  const child: ChildProfile = {
    id: nanoid(),
    name,
    avatar: avatar ?? '',
    balance: 0,
    dailyAllowance: dailyAllowance ?? store.getSnapshot().config.defaultDailyAllowance,
    rewardRules: [],
    createdAt: now,
    updatedAt: now
  };

  store.update((draft) => {
    draft.children.push(child);
  });

  res.json({ success: true, data: child });
});

app.put('/api/children/:childId', requireAuth, requireRole('admin'), (req, res) => {
  const { childId } = req.params;
  const { name, avatar } = req.body as { name?: string; avatar?: string };

  store.update((draft) => {
    const child = draft.children.find((item) => item.id === childId);
    if (!child) {
      return;
    }
    if (name) {
      child.name = name;
    }
    if (avatar !== undefined) {
      child.avatar = avatar;
    }
    child.updatedAt = new Date().toISOString();
  });

  res.json({ success: true, message: '更新成功' });
});

app.delete('/api/children/:childId', requireAuth, requireRole('admin'), (req, res) => {
  const { childId } = req.params;
  store.update((draft) => {
    draft.children = draft.children.filter((item) => item.id !== childId);
    draft.users.forEach((user) => {
      user.childIds = user.childIds.filter((id) => id !== childId);
    });
  });
  res.json({ success: true, message: '删除成功' });
});

app.post('/api/children/:childId/adjust', requireAuth, async (req: AuthedRequest, res) => {
  const { childId } = req.params;
  const { amount, reason, type } = req.body as { amount?: number; reason?: string; type?: MoneyTransaction['type'] };
  const user = req.authUser as UserAccount;

  if (amount === undefined || Number.isNaN(Number(amount))) {
    res.status(400).json({ success: false, error: '金额必填' });
    return;
  }

  if (!canManageChild(user, childId)) {
    res.status(403).json({ success: false, error: '无权限操作该小孩' });
    return;
  }

  const transactionReason = reason ?? (amount >= 0 ? '发放零花钱' : '消费');

  try {
    const result = await applyTransaction({
      childId,
      amount: Number(amount),
      reason: transactionReason,
      type: type ?? (amount >= 0 ? 'manual' : 'expense'),
      source: user.role,
      actorUserId: user.id
    });
    res.json({ success: true, data: result.child });
  } catch (error) {
    res.status(400).json({ success: false, error: (error as Error).message });
  }
});

app.get('/api/operators', requireAuth, requireRole('admin'), (_req, res) => {
  const operators = store.getSnapshot().users.filter((item) => item.role === 'operator').map(sanitizeUser);
  res.json({ success: true, data: operators });
});

app.post('/api/operators', requireAuth, requireRole('admin'), async (req, res) => {
  const { username, password, childIds } = req.body as { username?: string; password?: string; childIds?: string[] };
  if (!username || !password) {
    res.status(400).json({ success: false, error: '用户名和密码必填' });
    return;
  }

  if (store.getSnapshot().users.some((item) => item.username === username)) {
    res.status(400).json({ success: false, error: '用户名已存在' });
    return;
  }

  const now = new Date().toISOString();
  const user: UserAccount = {
    id: nanoid(),
    username,
    passwordHash: await hashPassword(password),
    role: 'operator',
    boundFeishuUserId: '',
    childIds: childIds ?? [],
    createdAt: now,
    updatedAt: now
  };

  store.update((draft) => {
    draft.users.push(user);
  });

  res.json({ success: true, data: sanitizeUser(user) });
});

app.put('/api/operators/:userId', requireAuth, requireRole('admin'), (req, res) => {
  const { userId } = req.params;
  const { childIds, boundFeishuUserId } = req.body as { childIds?: string[]; boundFeishuUserId?: string };

  store.update((draft) => {
    const user = draft.users.find((item) => item.id === userId && item.role === 'operator');
    if (!user) {
      return;
    }
    if (childIds) {
      user.childIds = childIds;
    }
    if (boundFeishuUserId !== undefined) {
      user.boundFeishuUserId = boundFeishuUserId;
    }
    user.updatedAt = new Date().toISOString();
  });

  res.json({ success: true, message: '更新成功' });
});

app.delete('/api/operators/:userId', requireAuth, requireRole('admin'), (req, res) => {
  const { userId } = req.params;
  store.update((draft) => {
    draft.users = draft.users.filter((item) => item.id !== userId || item.role !== 'operator');
  });
  res.json({ success: true, message: '删除成功' });
});

app.put('/api/config/daily-allowance', requireAuth, requireRole('admin'), async (req, res) => {
  const { childId, amount } = req.body as { childId?: string; amount?: number };
  if (!childId || amount === undefined || amount < 0) {
    res.status(400).json({ success: false, error: 'childId 和 amount 必填，且金额必须>=0' });
    return;
  }

  store.update((draft) => {
    const child = draft.children.find((item) => item.id === childId);
    if (!child) {
      return;
    }
    child.dailyAllowance = Number(amount);
    child.updatedAt = new Date().toISOString();
  });

  const child = findChildById(childId);
  // 从数据库读取飞书 webhook，而非环境变量
  await sendRobotCard({
    title: '系统操作反馈：每日零花钱额度',
    lines: [
      `**识别结果**：成功`,
      `**对象**：${child?.name ?? childId}`,
      `**每日额度**：${amountYuan(Number(amount))}`
    ]
  });

  res.json({ success: true, message: '设置成功' });
});

app.put('/api/config/reward-rule', requireAuth, requireRole('admin'), async (req, res) => {
  const { childId, keyword, amount } = req.body as { childId?: string; keyword?: string; amount?: number };
  if (!childId || !keyword || amount === undefined || amount <= 0) {
    res.status(400).json({ success: false, error: 'childId、keyword、amount 必填且 amount>0' });
    return;
  }

  const rewardRule = {
    id: nanoid(),
    keyword,
    amount: Number(amount),
    createdAt: new Date().toISOString()
  };

  store.update((draft) => {
    const child = draft.children.find((item) => item.id === childId);
    if (!child) {
      return;
    }
    child.rewardRules = child.rewardRules.filter((item) => item.keyword !== keyword);
    child.rewardRules.push(rewardRule);
    child.updatedAt = new Date().toISOString();
  });

  const child = findChildById(childId);
  // 从数据库读取飞书 webhook，而非环境变量
  await sendRobotCard({
    title: '系统操作反馈：额外奖励规则',
    lines: [
      `**识别结果**：成功`,
      `**对象**：${child?.name ?? childId}`,
      `**奖励项目**：${keyword}`,
      `**奖励金额**：${amountYuan(Number(amount))}`
    ]
  });

  res.json({ success: true, message: '设置成功' });
});

app.put('/api/config/weekly-notify', requireAuth, requireRole('admin'), async (req, res) => {
  const { hour, minute } = req.body as { hour?: number; minute?: number };
  if (hour === undefined || minute === undefined || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    res.status(400).json({ success: false, error: 'hour 或 minute 非法' });
    return;
  }

  store.update((draft) => {
    draft.config.weeklyNotify = { hour: Number(hour), minute: Number(minute) };
  });

  scheduler.updateWeeklySchedule(Number(hour), Number(minute));

  // 从数据库读取飞书 webhook，而非环境变量
  await sendRobotCard({
    title: '系统操作反馈：每周统计通知',
    lines: [
      `**识别结果**：成功`,
      `**通知时间**：每周一 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    ]
  });

  res.json({ success: true, message: '设置成功' });
});

app.get('/api/config', requireAuth, (_req, res) => {
  res.json({ success: true, data: store.getSnapshot().config });
});

/**
 * PUT /api/config/system
 * 由管理员在 UI 中配置系统级参数
 */
app.put('/api/config/system', requireAuth, requireRole('admin'), (req: AuthedRequest, res) => {
  const {
    feishuMode,
    feishuWebhookUrl,
    feishuAppId,
    feishuAppSecret,
    feishuVerificationToken,
    feishuSigningSecret,
    feishuDefaultChatId
  } = req.body as {
    feishuMode?: 'app' | 'webhook';
    feishuWebhookUrl?: string;
    feishuAppId?: string;
    feishuAppSecret?: string;
    feishuVerificationToken?: string;
    feishuSigningSecret?: string;
    feishuDefaultChatId?: string;
  };

  store.update((draft) => {
    if (feishuMode !== undefined) {
      draft.config.feishuMode = feishuMode;
    }
    if (feishuWebhookUrl !== undefined) {
      draft.config.feishuWebhookUrl = feishuWebhookUrl;
    }
    if (feishuAppId !== undefined) {
      draft.config.feishuAppId = feishuAppId;
    }
    if (feishuAppSecret !== undefined) {
      draft.config.feishuAppSecret = feishuAppSecret;
    }
    if (feishuVerificationToken !== undefined) {
      draft.config.feishuVerificationToken = feishuVerificationToken;
    }
    if (feishuSigningSecret !== undefined) {
      draft.config.feishuSigningSecret = feishuSigningSecret;
    }
    if (feishuDefaultChatId !== undefined) {
      draft.config.feishuDefaultChatId = feishuDefaultChatId;
    }
  });

  res.json({ success: true, message: '系统配置已更新' });
});

app.get('/api/transactions', requireAuth, (req: AuthedRequest, res) => {
  const user = req.authUser as UserAccount;
  const all = store.getSnapshot().transactions;
  const list = user.role === 'admin'
    ? all
    : all.filter((item) => user.childIds.includes(item.childId));
  res.json({ success: true, data: list.slice(-200).reverse() });
});

app.get('/api/weekly-summaries', requireAuth, (req: AuthedRequest, res) => {
  const user = req.authUser as UserAccount;
  const all = store.getSnapshot().weeklySummaries;
  const list = user.role === 'admin'
    ? all
    : all.filter((item) => user.childIds.includes(item.childId));
  res.json({ success: true, data: list.slice(-50).reverse() });
});

app.post(['/api/feishu/webhook', '/api/feishu/events'], async (req: AuthedRequest, res) => {
  if (!verifyFeishuToken(req.body)) {
    res.status(401).json({ success: false, error: '飞书 token 校验失败' });
    return;
  }

  if (!verifyFeishuSignature(req)) {
    res.status(401).json({ success: false, error: '飞书签名校验失败' });
    return;
  }

  const body = req.body as { challenge?: string; type?: string; header?: { event_type?: string } };
  if (body?.challenge || body?.type === 'url_verification') {
    res.json({ challenge: body.challenge ?? '' });
    return;
  }

  const { senderOpenId, senderType, messageType, contentRaw, chatId } = extractFeishuEvent(req.body);

  if (chatId) {
    store.update((draft) => {
      draft.config.lastActiveChatId = chatId;
    });
  }

  const eventType = body?.header?.event_type;
  if (eventType && eventType !== 'im.message.receive_v1') {
    res.json({ success: true, ignored: true, reason: 'unsupported_event_type' });
    return;
  }

  if (senderType === 'bot') {
    res.json({ success: true, ignored: true, reason: 'bot_sender' });
    return;
  }

  if (!senderOpenId || !contentRaw || (messageType && messageType !== 'text')) {
    res.json({ success: true, ignored: true, reason: 'invalid_payload' });
    return;
  }

  if (store.getSnapshot().config.ignoreBotUserIds.includes(senderOpenId)) {
    res.json({ success: true, ignored: true, reason: 'ignored_sender' });
    return;
  }

  const user = store.getSnapshot().users.find((item) => item.boundFeishuUserId === senderOpenId);
  if (!user) {
    res.json({ success: true, ignored: true, reason: 'unbound_sender' });
    return;
  }

  let text = '';
  try {
    const content = JSON.parse(contentRaw) as { text?: string };
    text = content.text ?? '';
  } catch {
    text = contentRaw;
  }

  const parserModel = resolveParserModelConfig();
  const action = await parseBotAction(text, parserModel.apiKey, parserModel.apiUrl, parserModel.modelId);
  if (action.intent === 'unknown') {
    res.json({ success: true, ignored: true, reason: 'unrecognized' });
    return;
  }

  const targetChild = resolveChildFromAction(action, user);
  if (!targetChild && action.intent !== 'set_weekly_notify') {
    res.status(400).json({ success: false, error: '未找到目标小孩或无权限' });
    return;
  }

  switch (action.intent) {
    case 'set_daily_allowance': {
      if (user.role !== 'admin') {
        res.status(403).json({ success: false, error: '仅管理员可调整每日额度' });
        return;
      }
      if (!targetChild || action.amount === undefined) {
        res.status(400).json({ success: false, error: '缺少参数' });
        return;
      }
      store.update((draft) => {
        const child = draft.children.find((item) => item.id === targetChild.id);
        if (!child) {
          return;
        }
        child.dailyAllowance = action.amount as number;
        child.updatedAt = new Date().toISOString();
      });
      await sendRobotCard({
        title: '系统操作反馈：每日额度调整',
        lines: [
          `**识别结果**：成功`,
          `**对象**：${targetChild.name}`,
          `**每日零花钱总金额**：${amountYuan(action.amount as number)}`
        ]
      }, chatId);
      break;
    }
    case 'set_reward_rule': {
      if (user.role !== 'admin') {
        res.status(403).json({ success: false, error: '仅管理员可设置奖励项目' });
        return;
      }
      if (!targetChild || !action.rewardKeyword || action.amount === undefined) {
        res.status(400).json({ success: false, error: '缺少参数' });
        return;
      }
      const rule = {
        id: nanoid(),
        keyword: action.rewardKeyword,
        amount: action.amount,
        createdAt: new Date().toISOString()
      };
      store.update((draft) => {
        const child = draft.children.find((item) => item.id === targetChild.id);
        if (!child) {
          return;
        }
        child.rewardRules = child.rewardRules.filter((item) => item.keyword !== action.rewardKeyword);
        child.rewardRules.push(rule);
      });
      await sendRobotCard({
        title: '系统操作反馈：额外奖励设置',
        lines: [
          `**识别结果**：成功`,
          `**对象**：${targetChild.name}`,
          `**奖励项目**：${action.rewardKeyword}`,
          `**奖励金额**：${amountYuan(action.amount)}`
        ]
      }, chatId);
      break;
    }
    case 'deduct_expense': {
      if (!targetChild || action.amount === undefined) {
        res.status(400).json({ success: false, error: '缺少参数' });
        return;
      }
      const delta = -action.amount;
      await applyTransaction({
        childId: targetChild.id,
        amount: delta,
        reason: action.reason ?? '消费',
        type: 'expense',
        source: 'bot',
        actorUserId: user.id
      });
      break;
    }
    case 'set_weekly_notify': {
      if (user.role !== 'admin') {
        res.status(403).json({ success: false, error: '仅管理员可设置周报时间' });
        return;
      }
      if (action.hour === undefined || action.minute === undefined) {
        res.status(400).json({ success: false, error: '缺少时间参数' });
        return;
      }
      store.update((draft) => {
        draft.config.weeklyNotify = {
          hour: action.hour as number,
          minute: action.minute as number
        };
      });
      scheduler.updateWeeklySchedule(action.hour, action.minute);
      await sendRobotCard({
        title: '系统操作反馈：每周统计通知',
        lines: [
          `**识别结果**：成功`,
          `**通知时间**：每周一 ${String(action.hour).padStart(2, '0')}:${String(action.minute).padStart(2, '0')}`
        ]
      }, chatId);
      break;
    }
    case 'reward_from_message': {
      if (!targetChild || !action.rewardKeyword) {
        res.status(400).json({ success: false, error: '缺少参数' });
        return;
      }
      const child = findChildById(targetChild.id);
      const reward = child?.rewardRules.find((item) => item.keyword === action.rewardKeyword);
      if (!reward) {
        res.json({ success: true, ignored: true, reason: 'no_reward_rule' });
        return;
      }
      await applyTransaction({
        childId: targetChild.id,
        amount: reward.amount,
        reason: action.reason ?? `完成${reward.keyword}`,
        type: 'reward',
        source: 'bot',
        actorUserId: user.id
      });
      break;
    }
    default:
      break;
  }

  res.json({ success: true, action });
});

app.get('/api/dashboard', requireAuth, (req: AuthedRequest, res) => {
  const user = req.authUser as UserAccount;
  const children = user.role === 'admin'
    ? store.getSnapshot().children
    : store.getSnapshot().children.filter((item) => user.childIds.includes(item.id));

  const totalBalance = children.reduce((sum, item) => sum + item.balance, 0);
  const monthlyExpense = store.getSnapshot().transactions
    .filter((item) => {
      if (!children.some((child) => child.id === item.childId)) {
        return false;
      }
      if (item.amount >= 0) {
        return false;
      }
      const date = new Date(item.createdAt);
      const now = new Date();
      return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
    })
    .reduce((sum, item) => sum + Math.abs(item.amount), 0);

  res.json({
    success: true,
    data: {
      children,
      totalBalance,
      monthlyExpense,
      weeklyNotify: store.getSnapshot().config.weeklyNotify
    }
  });
});

// ===== Model Config APIs =====
app.post('/api/models/discover', requireAuth, requireRole('admin'), async (req: AuthedRequest, res) => {
  const { provider, apiUrl, apiKey } = req.body as {
    provider?: ModelProvider;
    apiUrl?: string;
    apiKey?: string;
  };

  if (!provider || !apiUrl || !apiKey) {
    res.status(400).json({ success: false, error: 'provider、apiUrl、apiKey 必填' });
    return;
  }

  if (!['deepseek', 'openai', 'google', 'custom'].includes(provider)) {
    res.status(400).json({ success: false, error: '不支持的 provider' });
    return;
  }

  try {
    const models = await discoverProviderModels(provider, apiUrl, apiKey);
    if (models.length === 0) {
      res.status(400).json({ success: false, error: '成功连接但未获取到模型列表' });
      return;
    }
    res.json({ success: true, data: models });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : '获取模型列表失败' });
  }
});

app.get('/api/models', requireAuth, (req: AuthedRequest, res) => {
  const models = store.getAllModels();
  // 脱敏 API Key
  const sanitized = models.map(m => ({
    ...m,
    apiKey: undefined,
    hasApiKey: !!m.apiKey
  }));
  res.json({ success: true, data: sanitized });
});

app.post('/api/models', requireAuth, requireRole('admin'), async (req: AuthedRequest, res) => {
  const { name, provider, apiUrl, apiKey, modelId, isBuiltIn } = req.body as Partial<ModelConfig>;

  if (!name || !provider || !apiUrl) {
    res.status(400).json({ success: false, error: '名称、服务商和API地址必填' });
    return;
  }

  try {
    const model = store.addModel({
      name,
      provider: provider as any,
      apiUrl,
      apiKey,
      modelId,
      isBuiltIn: isBuiltIn ?? false,
      status: 'unconfigured'
    });

    res.json({ success: true, data: { ...model, apiKey: undefined, hasApiKey: !!model.apiKey } });
  } catch (error) {
    res.status(500).json({ success: false, error: '添加模型配置失败' });
  }
});

app.put('/api/models/:id', requireAuth, requireRole('admin'), async (req: AuthedRequest, res) => {
  const { id } = req.params;
  const updates = req.body as Partial<ModelConfig>;

  const model = store.getModel(id);
  if (!model) {
    res.status(404).json({ success: false, error: '模型不存在' });
    return;
  }

  try {
    const updated = store.updateModel(id, updates);
    if (!updated) {
      res.status(500).json({ success: false, error: '更新模型失败' });
      return;
    }

    res.json({ success: true, data: { ...updated, apiKey: undefined, hasApiKey: !!updated.apiKey } });
  } catch (error) {
    res.status(500).json({ success: false, error: '更新模型失败' });
  }
});

app.delete('/api/models/:id', requireAuth, requireRole('admin'), (req: AuthedRequest, res) => {
  const { id } = req.params;

  if (store.deleteModel(id)) {
    res.json({ success: true, message: '模型删除成功' });
  } else {
    res.status(404).json({ success: false, error: '模型不存在' });
  }
});

// ===== Prompt Template APIs =====
app.get('/api/prompts', requireAuth, (req: AuthedRequest, res) => {
  const prompts = store.getAllPrompts();
  res.json({ success: true, data: prompts });
});

app.post('/api/prompts', requireAuth, requireRole('admin'), (req: AuthedRequest, res) => {
  const { name, purpose, content, isBuiltIn } = req.body as Partial<PromptTemplate>;

  if (!name || !purpose || !content) {
    res.status(400).json({ success: false, error: '名称、用途和内容必填' });
    return;
  }

  try {
    const prompt = store.addPrompt({
      name,
      purpose: purpose as any,
      content,
      isBuiltIn: isBuiltIn ?? false,
      usageCount: 0
    });

    res.json({ success: true, data: prompt });
  } catch (error) {
    res.status(500).json({ success: false, error: '添加提示词模板失败' });
  }
});

app.put('/api/prompts/:id', requireAuth, requireRole('admin'), (req: AuthedRequest, res) => {
  const { id } = req.params;
  const updates = req.body as Partial<PromptTemplate>;

  const prompt = store.getPrompt(id);
  if (!prompt) {
    res.status(404).json({ success: false, error: '提示词模板不存在' });
    return;
  }

  try {
    const updated = store.updatePrompt(id, updates);
    if (!updated) {
      res.status(500).json({ success: false, error: '更新提示词模板失败' });
      return;
    }

    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: '更新提示词模板失败' });
  }
});

app.delete('/api/prompts/:id', requireAuth, requireRole('admin'), (req: AuthedRequest, res) => {
  const { id } = req.params;

  if (store.deletePrompt(id)) {
    res.json({ success: true, message: '提示词模板删除成功' });
  } else {
    res.status(404).json({ success: false, error: '提示词模板不存在' });
  }
});

if (fs.existsSync(frontendDistPath)) {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      next();
      return;
    }
    res.sendFile(path.join(frontendDistPath, 'index.html'));
  });
}

app.listen(port, host, () => {
  console.log(`Feishu Pocket backend running at http://${host}:${port}`);
});

export { store };
