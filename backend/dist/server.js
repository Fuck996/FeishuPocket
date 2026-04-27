import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { nanoid } from 'nanoid';
import * as Lark from '@larksuiteoapi/node-sdk';
import { comparePassword, hashPassword, signToken, verifyToken } from './auth.js';
import { parseBotAction } from './aiParser.js';
import { sendFeishuCard } from './feishu.js';
import { SchedulerService } from './scheduler.js';
import { JsonStore } from './store.js';
import { checkAllModelBalances } from './modelBalance.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3000);
// JWT Secret 完全自动化处理
// 优先级：持久化文件 > 首次启动自动生成
// 无需环保变量配置，容器重启后密钥保持不变
function initializeJwtSecret() {
    const jwtSecretPath = path.resolve(__dirname, '../data/.jwt-secret');
    // 1. 读取持久化文件（容器重启时复用）
    try {
        if (fs.existsSync(jwtSecretPath)) {
            const secret = fs.readFileSync(jwtSecretPath, 'utf-8').trim();
            console.log('[Init] Loaded persisted JWT secret from .jwt-secret');
            return secret;
        }
    }
    catch (error) {
        console.warn('[Warn] Failed to read .jwt-secret file:', error);
    }
    // 2. 首次启动，自动生成新密钥
    try {
        const secret = crypto.randomBytes(32).toString('base64');
        fs.mkdirSync(path.dirname(jwtSecretPath), { recursive: true });
        fs.writeFileSync(jwtSecretPath, secret, { mode: 0o600 });
        console.log('[Init] Generated new JWT secret and persisted to .jwt-secret');
        return secret;
    }
    catch (error) {
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
    limit: '5mb',
    verify: (req, _res, buffer) => {
        req.rawBody = buffer.toString('utf8');
    }
}));
// 一体化部署时由后端托管前端静态文件。
if (fs.existsSync(frontendDistPath)) {
    app.use(express.static(frontendDistPath));
}
function safeEqual(left, right) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
function verifyFeishuToken(body) {
    // 收集所有机器人的 verificationToken
    const tokens = store.getSnapshot().robots
        .map((r) => r.feishuVerificationToken)
        .filter(Boolean);
    // 也接受环境变量备用
    const envToken = process.env.FEISHU_VERIFICATION_TOKEN;
    if (envToken)
        tokens.push(envToken);
    if (tokens.length === 0) {
        return true; // 没有配置则不校验
    }
    const payload = body;
    const tokenInBody = payload?.header?.token ?? payload?.token;
    if (!tokenInBody) {
        return false;
    }
    return tokens.some((t) => safeEqual(t, tokenInBody));
}
function verifyFeishuSignature(req) {
    // 收集所有机器人的 signingSecret
    const secrets = store.getSnapshot().robots
        .map((r) => r.feishuSigningSecret)
        .filter(Boolean);
    const envSecret = process.env.FEISHU_SIGNING_SECRET;
    if (envSecret)
        secrets.push(envSecret);
    if (secrets.length === 0) {
        return true; // 没有配置则不校验
    }
    const secret = secrets[0]; // 使用第一个匹配（webhook 一般只有一个）
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
function extractFeishuEvent(reqBody) {
    const body = reqBody;
    const event = body.event ?? body;
    const sender = event.sender ?? {};
    const senderId = sender.sender_id ?? {};
    const message = event.message ?? body.message ?? {};
    const senderOpenId = senderId.open_id ??
        sender.open_id ??
        event.operator?.open_id ??
        body.open_id;
    const senderType = sender.sender_type ?? sender.type;
    const messageType = message.message_type ?? message.type;
    const chatId = message.chat_id ?? event.chat?.chat_id;
    const contentField = message.content;
    let contentRaw;
    if (typeof contentField === 'string') {
        contentRaw = contentField;
    }
    else if (contentField && typeof contentField === 'object') {
        contentRaw = JSON.stringify(contentField);
    }
    else if (typeof body.content === 'string') {
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
// 根据机器人对象解析飞书发送目标
function resolveTargetForRobot(robot, chatIdOverride) {
    const mode = robot.feishuMode ?? 'app';
    const resolvedChatId = chatIdOverride ?? robot.feishuDefaultChatId ?? robot.lastActiveChatId;
    if (mode === 'webhook') {
        return { mode, webhookUrl: robot.feishuWebhookUrl };
    }
    return {
        mode,
        appId: robot.feishuAppId,
        appSecret: robot.feishuAppSecret,
        chatId: resolvedChatId,
        webhookUrl: robot.feishuWebhookUrl
    };
}
// 根据孩子 ID 找到其管理机器人，解析飞书发送目标
function resolveFeishuTargetForChild(childId, chatIdOverride) {
    const robot = store.getSnapshot().robots.find((r) => r.enabled && r.childIds.includes(childId));
    if (robot) {
        return resolveTargetForRobot(robot, chatIdOverride);
    }
    // 无匹配机器人时，尝试第一个机器人作为兜底
    const fallback = store.getSnapshot().robots[0];
    if (fallback) {
        return resolveTargetForRobot(fallback, chatIdOverride);
    }
    return { mode: 'app' }; // 无任何机器人时空目标
}
// 兼容旧调用（无 childId 场景），使用第一个机器人
function resolveFeishuSendTarget(chatIdOverride) {
    const robot = store.getSnapshot().robots[0];
    if (robot) {
        return resolveTargetForRobot(robot, chatIdOverride);
    }
    return { mode: 'app' };
}
async function sendRobotCard(payload, chatIdOverride, childId) {
    const target = childId
        ? resolveFeishuTargetForChild(childId, chatIdOverride)
        : resolveFeishuSendTarget(chatIdOverride);
    await sendFeishuCard(target, payload);
}
function sanitizeUser(user) {
    return {
        id: user.id,
        username: user.username,
        role: user.role,
        boundFeishuUserId: user.boundFeishuUserId,
        childIds: user.childIds
    };
}
function findUserById(userId) {
    return store.getSnapshot().users.find((item) => item.id === userId);
}
function findChildById(childId) {
    return store.getSnapshot().children.find((item) => item.id === childId);
}
function canManageChild(user, childId) {
    if (user.role === 'admin') {
        return true;
    }
    return user.childIds.includes(childId);
}
function amountYuan(value) {
    return `${value.toFixed(2)}元`;
}
function inferSuggestion(increasedAmount, expenseAmount, remainingAmount) {
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
function normalizeApiUrl(provider, apiUrl) {
    const trimmed = apiUrl.trim().replace(/\/+$/, '');
    if ((provider === 'deepseek' || provider === 'openai') && trimmed.endsWith('/v1')) {
        return trimmed.slice(0, -3);
    }
    return trimmed;
}
function buildModelListEndpoint(provider, apiUrl) {
    const normalized = normalizeApiUrl(provider, apiUrl);
    if (provider === 'google') {
        return `${normalized}/v1beta/models`;
    }
    if (provider === 'deepseek' || provider === 'openai') {
        return `${normalized}/v1/models`;
    }
    return `${normalized}/models`;
}
async function discoverProviderModels(provider, apiUrl, apiKey) {
    const endpoint = buildModelListEndpoint(provider, apiUrl);
    const headers = {
        'Content-Type': 'application/json'
    };
    if (provider === 'google') {
        headers['x-goog-api-key'] = apiKey;
    }
    else {
        headers.Authorization = `Bearer ${apiKey}`;
    }
    const response = await fetch(endpoint, { method: 'GET', headers });
    if (!response.ok) {
        throw new Error(`模型列表获取失败 (${response.status})`);
    }
    const data = (await response.json());
    const list = provider === 'google'
        ? (data.models ?? []).map((item) => String(item.name ?? '').replace(/^models\//, '').trim())
        : (data.data ?? []).map((item) => String(item.id ?? '').trim());
    return Array.from(new Set(list.filter(Boolean))).sort((left, right) => left.localeCompare(right));
}
function resolveParserModelConfig() {
    const models = store.getAllModels();
    const preferredDeepSeek = models.find((item) => item.provider === 'deepseek' && item.isBuiltIn && item.apiKey && item.modelId);
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
function requireAuth(req, res, next) {
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
    }
    catch {
        res.status(401).json({ success: false, error: 'Token 无效' });
    }
}
function requireRole(role) {
    return (req, res, next) => {
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
async function applyTransaction(input) {
    const snapshot = store.getSnapshot();
    const child = snapshot.children.find((item) => item.id === input.childId);
    if (!child) {
        throw new Error('小孩不存在');
    }
    const transaction = {
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
    const sourceLabels = {
        admin: '管理员',
        operator: '操作员',
        bot: '飞书机器人',
        schedule: '定时任务',
        mcp: 'MCP工具'
    };
    // 若有操作者 ID，尝试查找用户名
    let actorDisplay = sourceLabels[input.source] ?? input.source;
    if (input.actorUserId) {
        const actor = store.getSnapshot().users.find((u) => u.id === input.actorUserId || u.username === input.actorUserId);
        actorDisplay = actor ? actor.username : input.actorUserId;
    }
    const updatedChild = store.getSnapshot().children.find((item) => item.id === input.childId);
    await sendRobotCard({
        title: '零花钱金额变动通知',
        lines: [
            `**对象**：${child.name}`,
            `**金额**：${input.amount > 0 ? '+' : ''}${amountYuan(input.amount)}`,
            `**类型**：${input.type}`,
            `**原因**：${input.reason}`,
            `**操作人**：${actorDisplay}`,
            `**当前余额**：${amountYuan(updatedChild?.balance ?? child.balance)}`
        ],
        // 携带撤销按钮，用户可在 30 分钟内点击撤销此次操作
        actions: [{
                text: '↩ 撤销此操作',
                type: 'danger',
                value: { action: 'undo_transaction', transactionId: transaction.id, childId: input.childId, amount: input.amount }
            }]
    }, undefined, input.childId);
    const updated = findChildById(input.childId);
    if (!updated) {
        throw new Error('小孩数据异常');
    }
    return { child: updated, transaction };
}
function getDefaultChildForRobot(robot) {
    const snapshot = store.getSnapshot();
    const firstId = robot.childIds[0];
    if (!firstId) {
        return undefined;
    }
    return snapshot.children.find((item) => item.id === firstId);
}
function canRobotManageChild(robot, childId) {
    return robot.childIds.includes(childId);
}
function resolveChildFromAction(action, robot) {
    const snapshot = store.getSnapshot();
    if (action.childName) {
        const found = snapshot.children.find((item) => item.name === action.childName);
        if (!found) {
            return undefined;
        }
        if (!canRobotManageChild(robot, found.id)) {
            return undefined;
        }
        return found;
    }
    return getDefaultChildForRobot(robot);
}
function normalizeStringArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return Array.from(new Set(value.map((item) => String(item ?? '').trim()).filter(Boolean)));
}
function resolveMatchedRobots(senderOpenId, chatId) {
    return store.getSnapshot().robots.filter((robot) => {
        if (!robot.enabled) {
            return false;
        }
        if (robot.controllerOpenIds.length > 0 && !robot.controllerOpenIds.includes(senderOpenId)) {
            return false;
        }
        if (robot.allowedChatIds.length === 0) {
            return true;
        }
        return !!chatId && robot.allowedChatIds.includes(chatId);
    });
}
function pickRobotForAction(robots, childName) {
    if (robots.length <= 1) {
        return robots[0];
    }
    if (!childName) {
        return robots[0];
    }
    const child = store.getSnapshot().children.find((item) => item.name === childName);
    if (!child) {
        return robots[0];
    }
    return robots.find((robot) => robot.childIds.includes(child.id)) ?? robots[0];
}
async function runDailyGrant() {
    const snapshot = store.getSnapshot();
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const grantTimes = snapshot.config.lastDailyGrantTimes ?? {};
    // 兼容旧版本迁移：若全局发放日期 = 今日，补全所有孩子的记录，避免升级后重复发放
    if (snapshot.config.lastDailyGrantDate === today) {
        const needsMigration = snapshot.children.some((c) => !grantTimes[c.id]);
        if (needsMigration) {
            store.update((draft) => {
                if (!draft.config.lastDailyGrantTimes)
                    draft.config.lastDailyGrantTimes = {};
                for (const child of snapshot.children) {
                    if (!draft.config.lastDailyGrantTimes[child.id]) {
                        draft.config.lastDailyGrantTimes[child.id] = today;
                    }
                }
            });
        }
        return;
    }
    let anyGranted = false;
    for (const child of snapshot.children) {
        // 若已在今日发放过，跳过
        if (grantTimes[child.id] === today) {
            continue;
        }
        // 读取该孩子配置的发放时刻，默认 08:00
        const grantHour = child.dailyGrantHour ?? 8;
        const grantMinute = child.dailyGrantMinute ?? 0;
        // 当前时刻 >= 配置时刻才发放
        if (currentHour < grantHour || (currentHour === grantHour && currentMinute < grantMinute)) {
            continue;
        }
        await applyTransaction({
            childId: child.id,
            amount: child.dailyAllowance,
            reason: '发放每日零花钱',
            type: 'daily',
            source: 'schedule'
        });
        store.update((draft) => {
            if (!draft.config.lastDailyGrantTimes) {
                draft.config.lastDailyGrantTimes = {};
            }
            draft.config.lastDailyGrantTimes[child.id] = today;
        });
        anyGranted = true;
    }
    if (anyGranted) {
        console.log(`[每日发放] ${today} 完成部分孩子零花钱发放`);
    }
}
function getLastWeekRange() {
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
async function runWeeklySummary() {
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
        const summary = {
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
async function checkModelBalances() {
    try {
        await checkAllModelBalances();
    }
    catch (error) {
        console.error('[Scheduler] Error checking model balances:', error);
    }
}
const snapshot = store.getSnapshot();
const scheduler = new SchedulerService({
    runDailyGrant,
    runWeeklySummary,
    checkModelBalances
}, snapshot.config.weeklyNotify.hour, snapshot.config.weeklyNotify.minute);
// 飞书 WS 长连接客户端（appId/appSecret 配置后自动连接）
let wsClientStarted = false;
function initFeishuWsClient() {
    // 使用第一个配置了 appId/appSecret 的机器人
    const robot = store.getSnapshot().robots.find((r) => r.feishuAppId && r.feishuAppSecret);
    const appId = robot?.feishuAppId;
    const appSecret = robot?.feishuAppSecret;
    const robotId = robot?.id;
    if (!appId || !appSecret) {
        console.log('[飞书WS] appId 或 appSecret 未配置，跳过长连接初始化');
        return;
    }
    if (wsClientStarted) {
        console.log('[飞书WS] 已启动，若需更新配置请重启服务');
        return;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const eventDispatcher = new Lark.EventDispatcher({}).register({
            'im.message.receive_v1': async (data) => {
                const { senderOpenId, senderType, messageType, contentRaw, chatId } = extractFeishuEvent(data);
                if (chatId && robotId) {
                    store.update((draft) => {
                        const r = draft.robots.find((item) => item.id === robotId);
                        if (r)
                            r.lastActiveChatId = chatId;
                    });
                }
                try {
                    await processBotMessage(senderOpenId, senderType, messageType, contentRaw, chatId);
                }
                catch (error) {
                    console.error('[飞书WS] 消息处理失败:', error);
                }
            },
            // card.action.trigger 不在 IHandles 类型中，通过 any 扩展
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            'card.action.trigger': async (data) => {
                try {
                    return await handleCardAction(data);
                }
                catch (error) {
                    console.error('[飞书WS] 卡片回调处理失败:', error);
                    return { toast: { type: 'error', content: '处理失败' } };
                }
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        });
        const wsClient = new Lark.WSClient({ appId, appSecret });
        wsClient.start({ eventDispatcher });
        wsClientStarted = true;
        console.log(`[飞书WS] 长连接客户端已启动，AppID: ${appId}`);
    }
    catch (error) {
        console.error('[飞书WS] 启动失败:', error);
    }
}
// 服务启动后初始化飞书 WS 连接
initFeishuWsClient();
// 启动时若有模型余额为空，立即获取一次
if (store.getAllModels().some((m) => m.provider === 'deepseek' && m.apiKey && m.balance === undefined)) {
    void checkModelBalances();
}
app.get('/api/version', (_req, res) => {
    res.json({ success: true, version: '0.3.1' });
});
app.get('/api/setup-status', (_req, res) => {
    const adminInitialized = store.getSnapshot().users.some((item) => item.role === 'admin');
    res.json({ success: true, data: { adminInitialized } });
});
app.post('/api/init-admin', async (req, res) => {
    const { username, password } = req.body;
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
    const admin = {
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
    const { username, password } = req.body;
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
app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ success: true, user: sanitizeUser(req.authUser) });
});
app.post('/api/auth/bind-feishu', requireAuth, (req, res) => {
    const { feishuUserId } = req.body;
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
app.get('/api/children', requireAuth, (req, res) => {
    const user = req.authUser;
    const list = user.role === 'admin'
        ? store.getSnapshot().children
        : store.getSnapshot().children.filter((item) => user.childIds.includes(item.id));
    res.json({ success: true, data: list });
});
app.post('/api/children', requireAuth, requireRole('admin'), (req, res) => {
    const { name, avatar, dailyAllowance, dailyGrantHour, dailyGrantMinute } = req.body;
    if (!name) {
        res.status(400).json({ success: false, error: '姓名必填' });
        return;
    }
    const now = new Date().toISOString();
    const child = {
        id: nanoid(),
        name,
        avatar: avatar ?? '',
        balance: 0,
        dailyAllowance: dailyAllowance ?? store.getSnapshot().config.defaultDailyAllowance,
        dailyGrantHour: dailyGrantHour !== undefined ? Number(dailyGrantHour) : undefined,
        dailyGrantMinute: dailyGrantMinute !== undefined ? Number(dailyGrantMinute) : undefined,
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
    const { name, avatar, dailyGrantHour, dailyGrantMinute } = req.body;
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
        if (dailyGrantHour !== undefined) {
            child.dailyGrantHour = Number(dailyGrantHour);
        }
        if (dailyGrantMinute !== undefined) {
            child.dailyGrantMinute = Number(dailyGrantMinute);
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
app.post('/api/children/:childId/adjust', requireAuth, async (req, res) => {
    const { childId } = req.params;
    const { amount, reason, type } = req.body;
    const user = req.authUser;
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
    }
    catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});
app.get('/api/operators', requireAuth, requireRole('admin'), (_req, res) => {
    const operators = store.getSnapshot().users.filter((item) => item.role === 'operator').map(sanitizeUser);
    res.json({ success: true, data: operators });
});
app.post('/api/operators', requireAuth, requireRole('admin'), async (req, res) => {
    const { username, password, childIds } = req.body;
    if (!username || !password) {
        res.status(400).json({ success: false, error: '用户名和密码必填' });
        return;
    }
    if (store.getSnapshot().users.some((item) => item.username === username)) {
        res.status(400).json({ success: false, error: '用户名已存在' });
        return;
    }
    const now = new Date().toISOString();
    const user = {
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
    const { childIds, boundFeishuUserId } = req.body;
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
app.get('/api/robots', requireAuth, requireRole('admin'), (_req, res) => {
    res.json({ success: true, data: store.getSnapshot().robots });
});
app.post('/api/robots', requireAuth, requireRole('admin'), (req, res) => {
    const { name, enabled, childIds, controllerOpenIds, allowedChatIds, feishuMode, feishuAppId, feishuAppSecret, feishuWebhookUrl, feishuVerificationToken, feishuSigningSecret, feishuDefaultChatId } = req.body;
    const normalizedName = String(name ?? '').trim();
    const normalizedChildIds = normalizeStringArray(childIds);
    const normalizedControllerOpenIds = normalizeStringArray(controllerOpenIds);
    const normalizedAllowedChatIds = normalizeStringArray(allowedChatIds);
    if (!normalizedName) {
        res.status(400).json({ success: false, error: '机器人名称必填' });
        return;
    }
    if (normalizedChildIds.length === 0) {
        res.status(400).json({ success: false, error: '至少绑定一个小孩' });
        return;
    }
    const now = new Date().toISOString();
    const robot = {
        id: nanoid(),
        name: normalizedName,
        enabled: enabled !== false,
        childIds: normalizedChildIds,
        controllerOpenIds: normalizedControllerOpenIds,
        allowedChatIds: normalizedAllowedChatIds,
        feishuMode: feishuMode ?? undefined,
        feishuAppId: feishuAppId ?? undefined,
        feishuAppSecret: feishuAppSecret ?? undefined,
        feishuWebhookUrl: feishuWebhookUrl ?? undefined,
        feishuVerificationToken: feishuVerificationToken ?? undefined,
        feishuSigningSecret: feishuSigningSecret ?? undefined,
        feishuDefaultChatId: feishuDefaultChatId ?? undefined,
        createdAt: now,
        updatedAt: now
    };
    store.update((draft) => {
        draft.robots.push(robot);
    });
    res.json({ success: true, data: robot });
});
app.put('/api/robots/:robotId', requireAuth, requireRole('admin'), (req, res) => {
    const { robotId } = req.params;
    const { name, enabled, childIds, controllerOpenIds, allowedChatIds, feishuMode, feishuAppId, feishuAppSecret, feishuWebhookUrl, feishuVerificationToken, feishuSigningSecret, feishuDefaultChatId } = req.body;
    const exists = store.getSnapshot().robots.some((item) => item.id === robotId);
    if (!exists) {
        res.status(404).json({ success: false, error: '机器人不存在' });
        return;
    }
    const normalizedName = name === undefined ? undefined : String(name).trim();
    const normalizedChildIds = childIds === undefined ? undefined : normalizeStringArray(childIds);
    const normalizedControllerOpenIds = controllerOpenIds === undefined ? undefined : normalizeStringArray(controllerOpenIds);
    const normalizedAllowedChatIds = allowedChatIds === undefined ? undefined : normalizeStringArray(allowedChatIds);
    if (normalizedName !== undefined && !normalizedName) {
        res.status(400).json({ success: false, error: '机器人名称不能为空' });
        return;
    }
    if (normalizedChildIds !== undefined && normalizedChildIds.length === 0) {
        res.status(400).json({ success: false, error: '至少绑定一个小孩' });
        return;
    }
    let updatedRobot;
    store.update((draft) => {
        const robot = draft.robots.find((item) => item.id === robotId);
        if (!robot) {
            return;
        }
        if (normalizedName !== undefined)
            robot.name = normalizedName;
        if (enabled !== undefined)
            robot.enabled = enabled;
        if (normalizedChildIds !== undefined)
            robot.childIds = normalizedChildIds;
        if (normalizedControllerOpenIds !== undefined)
            robot.controllerOpenIds = normalizedControllerOpenIds;
        if (normalizedAllowedChatIds !== undefined)
            robot.allowedChatIds = normalizedAllowedChatIds;
        if (feishuMode !== undefined)
            robot.feishuMode = feishuMode;
        if (feishuAppId !== undefined)
            robot.feishuAppId = feishuAppId;
        if (feishuAppSecret !== undefined)
            robot.feishuAppSecret = feishuAppSecret;
        if (feishuWebhookUrl !== undefined)
            robot.feishuWebhookUrl = feishuWebhookUrl;
        if (feishuVerificationToken !== undefined)
            robot.feishuVerificationToken = feishuVerificationToken;
        if (feishuSigningSecret !== undefined)
            robot.feishuSigningSecret = feishuSigningSecret;
        if (feishuDefaultChatId !== undefined)
            robot.feishuDefaultChatId = feishuDefaultChatId;
        robot.updatedAt = new Date().toISOString();
        updatedRobot = robot;
    });
    res.json({ success: true, data: updatedRobot });
});
app.delete('/api/robots/:robotId', requireAuth, requireRole('admin'), (req, res) => {
    const { robotId } = req.params;
    let removed = false;
    store.update((draft) => {
        const before = draft.robots.length;
        draft.robots = draft.robots.filter((item) => item.id !== robotId);
        removed = before !== draft.robots.length;
    });
    if (!removed) {
        res.status(404).json({ success: false, error: '机器人不存在' });
        return;
    }
    res.json({ success: true, message: '机器人已删除' });
});
app.post('/api/robots/:robotId/test', requireAuth, requireRole('admin'), async (req, res) => {
    const { robotId } = req.params;
    const robot = store.getSnapshot().robots.find((r) => r.id === robotId);
    if (!robot) {
        res.status(404).json({ success: false, error: '机器人不存在' });
        return;
    }
    try {
        const target = resolveTargetForRobot(robot);
        if ((target.mode === 'app' && (!target.appId || !target.appSecret || !target.chatId)) ||
            (target.mode === 'webhook' && !target.webhookUrl)) {
            res.status(400).json({ success: false, error: '凭证或默认 Chat ID 未配置，无法发送' });
            return;
        }
        await sendFeishuCard(target, {
            title: '✅ 连接测试',
            lines: [
                `**机器人名称**：${robot.name}`,
                `**接入方式**：${robot.feishuMode === 'webhook' ? '群 webhook' : '自建应用 WS 长连接'}`,
                `**时间**：${new Date().toLocaleString('zh-CN')}`,
                `**状态**：消息发送成功，飞书连接正常 🎉`
            ]
        });
        res.json({ success: true, message: '测试消息已发送' });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : '发送失败';
        res.status(500).json({ success: false, error: message });
    }
});
app.put('/api/config/daily-allowance', requireAuth, requireRole('admin'), async (req, res) => {
    const { childId, amount } = req.body;
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
    const { childId, keyword, amount } = req.body;
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
app.delete('/api/config/reward-rule', requireAuth, requireRole('admin'), async (req, res) => {
    const { childId, keyword } = req.body;
    if (!childId || !keyword) {
        res.status(400).json({ success: false, error: 'childId、keyword 必填' });
        return;
    }
    const child = findChildById(childId);
    if (!child) {
        res.status(404).json({ success: false, error: '孩子不存在' });
        return;
    }
    store.update((draft) => {
        const c = draft.children.find((item) => item.id === childId);
        if (!c)
            return;
        c.rewardRules = c.rewardRules.filter((item) => item.keyword !== keyword);
        c.updatedAt = new Date().toISOString();
    });
    res.json({ success: true, message: '奖励规则已删除' });
});
app.put('/api/config/weekly-notify', requireAuth, requireRole('admin'), async (req, res) => {
    const { hour, minute } = req.body;
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
// 兼容旧版 API：飞书配置已迁移至机器人，此端点自动更新第一个机器人的配置
app.put('/api/config/system', requireAuth, requireRole('admin'), (req, res) => {
    const { feishuMode, feishuWebhookUrl, feishuAppId, feishuAppSecret, feishuVerificationToken, feishuSigningSecret, feishuDefaultChatId } = req.body;
    const firstRobot = store.getSnapshot().robots[0];
    if (!firstRobot) {
        res.status(400).json({ success: false, error: '请先创建机器人，飞书配置现在按机器人设置' });
        return;
    }
    store.update((draft) => {
        const robot = draft.robots.find((r) => r.id === firstRobot.id);
        if (!robot)
            return;
        if (feishuMode !== undefined)
            robot.feishuMode = feishuMode;
        if (feishuWebhookUrl !== undefined)
            robot.feishuWebhookUrl = feishuWebhookUrl;
        if (feishuAppId !== undefined)
            robot.feishuAppId = feishuAppId;
        if (feishuAppSecret !== undefined)
            robot.feishuAppSecret = feishuAppSecret;
        if (feishuVerificationToken !== undefined)
            robot.feishuVerificationToken = feishuVerificationToken;
        if (feishuSigningSecret !== undefined)
            robot.feishuSigningSecret = feishuSigningSecret;
        if (feishuDefaultChatId !== undefined)
            robot.feishuDefaultChatId = feishuDefaultChatId;
    });
    res.json({ success: true, message: '配置已更新到机器人' });
});
app.get('/api/transactions', requireAuth, (req, res) => {
    const user = req.authUser;
    const all = store.getSnapshot().transactions;
    const list = user.role === 'admin'
        ? all
        : all.filter((item) => user.childIds.includes(item.childId));
    res.json({ success: true, data: [...list].reverse() });
});
app.get('/api/weekly-summaries', requireAuth, (req, res) => {
    const user = req.authUser;
    const all = store.getSnapshot().weeklySummaries;
    const list = user.role === 'admin'
        ? all
        : all.filter((item) => user.childIds.includes(item.childId));
    res.json({ success: true, data: list.slice(-50).reverse() });
});
// 处理卡片按钮回调（card.action.trigger），返回飞书 toast 响应
async function handleCardAction(eventData) {
    const data = eventData;
    const action = data.action;
    const actionValue = action?.value ?? {};
    const actionType = actionValue['action'];
    const contextObj = data.context;
    const chatId = contextObj?.open_chat_id;
    switch (actionType) {
        case 'undo_transaction': {
            const transactionId = actionValue['transactionId'];
            const childId = actionValue['childId'];
            if (!transactionId || !childId) {
                return { toast: { type: 'error', content: '参数无效', i18n: { zh_cn: '参数无效' } } };
            }
            let found = false;
            let reversedAmount = 0;
            let childName = '';
            store.update((draft) => {
                const idx = draft.transactions.findIndex((t) => t.id === transactionId);
                if (idx >= 0) {
                    reversedAmount = draft.transactions[idx].amount;
                    draft.transactions.splice(idx, 1);
                    const child = draft.children.find((c) => c.id === childId);
                    if (child) {
                        child.balance -= reversedAmount;
                        child.updatedAt = new Date().toISOString();
                        childName = child.name;
                    }
                    found = true;
                }
            });
            if (!found) {
                return { toast: { type: 'error', content: '操作已失效或已被撤销', i18n: { zh_cn: '操作已失效或已被撤销' } } };
            }
            try {
                await sendRobotCard({
                    title: '操作已撤销',
                    lines: [
                        `**对象**：${childName || childId}`,
                        `**逆向金额**：${reversedAmount > 0 ? '-' : '+'}${amountYuan(Math.abs(reversedAmount))}`,
                        `**操作时间**：${new Date().toLocaleString('zh-CN')}`
                    ],
                    color: 'grey'
                }, chatId);
            }
            catch {
                // 通知失败不阻断撤销成功
            }
            return { toast: { type: 'success', content: '已成功撤销', i18n: { zh_cn: '已成功撤销' } } };
        }
        default:
            return { toast: { type: 'info', content: '收到交互', i18n: { zh_cn: '收到交互' } } };
    }
}
// 处理机器人消息，返回已解析的 action，忽略时返回 null，出错时抛出异常
async function processBotMessage(senderOpenId, senderType, messageType, contentRaw, chatId) {
    if (senderType === 'bot')
        return null;
    if (!senderOpenId || !contentRaw || (messageType && messageType !== 'text'))
        return null;
    if (store.getSnapshot().config.ignoreBotUserIds.includes(senderOpenId))
        return null;
    const matchedRobots = resolveMatchedRobots(senderOpenId, chatId);
    if (matchedRobots.length === 0)
        return null;
    let text = '';
    try {
        const content = JSON.parse(contentRaw);
        text = content.text ?? '';
    }
    catch {
        text = contentRaw;
    }
    const parserModel = resolveParserModelConfig();
    const action = await parseBotAction(text, parserModel.apiKey, parserModel.apiUrl, parserModel.modelId);
    // LLM 调用后异步刷新余额，不阻塞主流程
    void checkModelBalances();
    if (action.intent === 'unknown')
        return null;
    const robot = pickRobotForAction(matchedRobots, action.childName);
    if (!robot)
        return null;
    const targetChild = resolveChildFromAction(action, robot);
    if (!targetChild && action.intent !== 'set_weekly_notify') {
        throw new Error('未找到目标小孩或无权限');
    }
    switch (action.intent) {
        case 'set_daily_allowance': {
            if (!targetChild || action.amount === undefined)
                throw new Error('缺少参数');
            store.update((draft) => {
                const child = draft.children.find((item) => item.id === targetChild.id);
                if (!child)
                    return;
                child.dailyAllowance = action.amount;
                child.updatedAt = new Date().toISOString();
            });
            await sendRobotCard({
                title: '系统操作反馈：每日额度调整',
                lines: [
                    `**识别结果**：成功`,
                    `**对象**：${targetChild.name}`,
                    `**每日零花钱总金额**：${amountYuan(action.amount)}`
                ]
            }, chatId, targetChild.id);
            break;
        }
        case 'set_reward_rule': {
            if (!targetChild || !action.rewardKeyword || action.amount === undefined)
                throw new Error('缺少参数');
            const rule = {
                id: nanoid(),
                keyword: action.rewardKeyword,
                amount: action.amount,
                createdAt: new Date().toISOString()
            };
            store.update((draft) => {
                const child = draft.children.find((item) => item.id === targetChild.id);
                if (!child)
                    return;
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
            }, chatId, targetChild.id);
            break;
        }
        case 'deduct_expense': {
            if (!targetChild || action.amount === undefined)
                throw new Error('缺少参数');
            await applyTransaction({
                childId: targetChild.id,
                amount: -action.amount,
                reason: action.reason ?? '消费',
                type: 'expense',
                source: 'bot',
                actorUserId: undefined
            });
            break;
        }
        case 'set_weekly_notify': {
            if (action.hour === undefined || action.minute === undefined)
                throw new Error('缺少时间参数');
            store.update((draft) => {
                draft.config.weeklyNotify = {
                    hour: action.hour,
                    minute: action.minute
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
            if (!targetChild || !action.rewardKeyword)
                throw new Error('缺少参数');
            const child = findChildById(targetChild.id);
            const reward = child?.rewardRules.find((item) => item.keyword === action.rewardKeyword);
            if (!reward)
                return null; // 无匹配奖励规则，忽略
            await applyTransaction({
                childId: targetChild.id,
                amount: reward.amount,
                reason: action.reason ?? `完成${reward.keyword}`,
                type: 'reward',
                source: 'bot',
                actorUserId: undefined
            });
            break;
        }
        default:
            break;
    }
    return action;
}
app.post(['/api/feishu/webhook', '/api/feishu/events'], async (req, res) => {
    if (!verifyFeishuToken(req.body)) {
        res.status(401).json({ success: false, error: '飞书 token 校验失败' });
        return;
    }
    if (!verifyFeishuSignature(req)) {
        res.status(401).json({ success: false, error: '飞书签名校验失败' });
        return;
    }
    const body = req.body;
    if (body?.challenge || body?.type === 'url_verification') {
        res.json({ challenge: body.challenge ?? '' });
        return;
    }
    const eventType = body?.header?.event_type;
    // 处理卡片按钮回调
    if (eventType === 'card.action.trigger') {
        const bodyData = req.body;
        const eventData = bodyData.event ?? bodyData;
        try {
            const result = await handleCardAction(eventData);
            res.json(result);
        }
        catch (error) {
            console.error('[飞书Webhook] 卡片回调处理失败:', error);
            res.json({ toast: { type: 'error', content: '处理失败' } });
        }
        return;
    }
    if (eventType && eventType !== 'im.message.receive_v1') {
        res.json({ success: true, ignored: true, reason: 'unsupported_event_type' });
        return;
    }
    const { senderOpenId, senderType, messageType, contentRaw, chatId } = extractFeishuEvent(req.body);
    if (chatId) {
        // 找到对应的机器人并更新其最近活跃 chatId
        const matchedRobot = store.getSnapshot().robots.find((r) => r.allowedChatIds.length === 0 || r.allowedChatIds.includes(chatId));
        if (matchedRobot) {
            store.update((draft) => {
                const r = draft.robots.find((item) => item.id === matchedRobot.id);
                if (r)
                    r.lastActiveChatId = chatId;
            });
        }
    }
    try {
        const action = await processBotMessage(senderOpenId, senderType, messageType, contentRaw, chatId);
        if (!action) {
            res.json({ success: true, ignored: true });
            return;
        }
        res.json({ success: true, action });
    }
    catch (error) {
        res.status(400).json({ success: false, error: error instanceof Error ? error.message : '处理失败' });
    }
});
app.get('/api/dashboard', requireAuth, (req, res) => {
    const user = req.authUser;
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
app.post('/api/models/discover', requireAuth, requireRole('admin'), async (req, res) => {
    const { provider, apiUrl, apiKey } = req.body;
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
    }
    catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : '获取模型列表失败' });
    }
});
app.get('/api/models', requireAuth, (req, res) => {
    const models = store.getAllModels();
    // 脱敏 API Key
    const sanitized = models.map(m => ({
        ...m,
        apiKey: undefined,
        hasApiKey: !!m.apiKey
    }));
    res.json({ success: true, data: sanitized });
});
app.post('/api/models', requireAuth, requireRole('admin'), async (req, res) => {
    const { name, provider, apiUrl, apiKey, modelId, isBuiltIn } = req.body;
    if (!name || !provider || !apiUrl) {
        res.status(400).json({ success: false, error: '名称、服务商和API地址必填' });
        return;
    }
    try {
        const model = store.addModel({
            name,
            provider: provider,
            apiUrl,
            apiKey,
            modelId,
            isBuiltIn: isBuiltIn ?? false,
            status: (apiKey && modelId) ? 'disconnected' : 'unconfigured'
        });
        res.json({ success: true, data: { ...model, apiKey: undefined, hasApiKey: !!model.apiKey } });
    }
    catch (error) {
        res.status(500).json({ success: false, error: '添加模型配置失败' });
    }
});
app.put('/api/models/:id', requireAuth, requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const updates = req.body;
    const model = store.getModel(id);
    if (!model) {
        res.status(404).json({ success: false, error: '模型不存在' });
        return;
    }
    try {
        // 若提供了新的 apiKey，重置状态为已配置（待测试）
        if (updates.apiKey) {
            updates.status = 'disconnected';
        }
        const updated = store.updateModel(id, updates);
        if (!updated) {
            res.status(500).json({ success: false, error: '更新模型失败' });
            return;
        }
        res.json({ success: true, data: { ...updated, apiKey: undefined, hasApiKey: !!updated.apiKey } });
    }
    catch (error) {
        res.status(500).json({ success: false, error: '更新模型失败' });
    }
});
app.delete('/api/models/:id', requireAuth, requireRole('admin'), (req, res) => {
    const { id } = req.params;
    if (store.deleteModel(id)) {
        res.json({ success: true, message: '模型删除成功' });
    }
    else {
        res.status(404).json({ success: false, error: '模型不存在' });
    }
});
// ===== Prompt Template APIs =====
app.get('/api/prompts', requireAuth, (req, res) => {
    const prompts = store.getAllPrompts();
    res.json({ success: true, data: prompts });
});
app.post('/api/prompts', requireAuth, requireRole('admin'), (req, res) => {
    const { name, purpose, content, isBuiltIn } = req.body;
    if (!name || !purpose || !content) {
        res.status(400).json({ success: false, error: '名称、用途和内容必填' });
        return;
    }
    try {
        const prompt = store.addPrompt({
            name,
            purpose: purpose,
            content,
            isBuiltIn: isBuiltIn ?? false,
            usageCount: 0
        });
        res.json({ success: true, data: prompt });
    }
    catch (error) {
        res.status(500).json({ success: false, error: '添加提示词模板失败' });
    }
});
app.put('/api/prompts/:id', requireAuth, requireRole('admin'), (req, res) => {
    const { id } = req.params;
    const updates = req.body;
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
    }
    catch (error) {
        res.status(500).json({ success: false, error: '更新提示词模板失败' });
    }
});
app.delete('/api/prompts/:id', requireAuth, requireRole('admin'), (req, res) => {
    const { id } = req.params;
    if (store.deletePrompt(id)) {
        res.json({ success: true, message: '提示词模板删除成功' });
    }
    else {
        res.status(404).json({ success: false, error: '提示词模板不存在' });
    }
});
app.use((error, req, res, next) => {
    if (!req.path.startsWith('/api/')) {
        next(error);
        return;
    }
    console.error('[API ERROR]', error);
    res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : '服务器内部错误'
    });
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
