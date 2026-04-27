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
// 内存日志，按机器人 ID 存储，最多保留每机器人 200 条
const botLogs = new Map();
const BOT_LOG_MAX = 200;
const inboundMessageDedup = new Map();
const INBOUND_MESSAGE_DEDUP_TTL_MS = 10 * 60 * 1000;
function pushBotLog(entry) {
    const list = botLogs.get(entry.robotId) ?? [];
    list.push(entry);
    if (list.length > BOT_LOG_MAX)
        list.splice(0, list.length - BOT_LOG_MAX);
    botLogs.set(entry.robotId, list);
}
function cleanupInboundMessageDedup(now) {
    for (const [messageId, expireAt] of inboundMessageDedup.entries()) {
        if (expireAt <= now) {
            inboundMessageDedup.delete(messageId);
        }
    }
}
function shouldProcessInboundMessage(messageId) {
    if (!messageId) {
        return true;
    }
    const now = Date.now();
    cleanupInboundMessageDedup(now);
    const expireAt = inboundMessageDedup.get(messageId);
    if (expireAt && expireAt > now) {
        return false;
    }
    inboundMessageDedup.set(messageId, now + INBOUND_MESSAGE_DEDUP_TTL_MS);
    return true;
}
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
    const timestamp = req.header('x-lark-request-timestamp') ?? req.header('X-Lark-Request-Timestamp');
    const nonce = req.header('x-lark-request-nonce') ?? req.header('X-Lark-Request-Nonce');
    const signature = req.header('x-lark-signature') ?? req.header('X-Lark-Signature');
    const rawBody = req.rawBody ?? '';
    if (!timestamp || !nonce || !signature) {
        return false;
    }
    const plain = `${timestamp}${nonce}${rawBody}`;
    return secrets.some((secret) => {
        const base64Sign = crypto.createHmac('sha256', secret).update(plain).digest('base64');
        const hexSign = crypto.createHmac('sha256', secret).update(plain).digest('hex');
        const withPrefix = `sha256=${hexSign}`;
        return safeEqual(signature, base64Sign) || safeEqual(signature, hexSign) || safeEqual(signature, withPrefix);
    });
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
    const messageId = message.message_id;
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
        chatId,
        messageId
    };
}
function extractMessageText(contentRaw, messageType) {
    try {
        const content = JSON.parse(contentRaw);
        if (typeof content.text === 'string') {
            return content.text;
        }
        // 富文本消息：post.zh_cn.content = 二维数组，按段拼接文本
        if (messageType === 'post') {
            const post = content.post;
            const zh = post?.zh_cn;
            const blocks = zh?.content;
            if (Array.isArray(blocks)) {
                const merged = blocks
                    .flat()
                    .map((item) => (typeof item.text === 'string' ? item.text : ''))
                    .join('')
                    .trim();
                if (merged) {
                    return merged;
                }
            }
        }
    }
    catch {
        return contentRaw;
    }
    return contentRaw;
}
function parsePreciseBotCommand(text) {
    const normalized = text.trim();
    // 0) 帮助 / 指令 / 说明
    if (/^(帮助|指令|说明)$/.test(normalized)) {
        return { intent: 'show_help' };
    }
    // 1) 发放零花钱（精确指令不接收孩子名，默认按机器人绑定孩子执行）
    if (/^发放零花钱$/.test(normalized)) {
        return {
            intent: 'manual_grant_daily_allowance'
        };
    }
    // 2) 余额增加：n
    const increase = normalized.match(/^余额增加\s*[：:]\s*(-?\d+(?:\.\d+)?)$/);
    if (increase) {
        return {
            intent: 'increase_balance',
            amount: Math.abs(Number(increase[1]))
        };
    }
    // 2.1) +n
    const increaseShort = normalized.match(/^\+\s*(\d+(?:\.\d+)?)$/);
    if (increaseShort) {
        return {
            intent: 'increase_balance',
            amount: Math.abs(Number(increaseShort[1]))
        };
    }
    // 3) 余额减少：n
    const decrease = normalized.match(/^余额减少\s*[：:]\s*(-?\d+(?:\.\d+)?)$/);
    if (decrease) {
        return {
            intent: 'decrease_balance',
            amount: Math.abs(Number(decrease[1]))
        };
    }
    // 3.1) -n
    const decreaseShort = normalized.match(/^\-\s*(\d+(?:\.\d+)?)$/);
    if (decreaseShort) {
        return {
            intent: 'decrease_balance',
            amount: Math.abs(Number(decreaseShort[1]))
        };
    }
    // 4) 查询余额 / 余额
    if (/^(查询余额|余额)$/.test(normalized)) {
        return { intent: 'query_balance' };
    }
    return null;
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
    return await sendFeishuCard(target, payload);
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
function amountWithSign(value) {
    return `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
}
function resolveAvatarForFeishu(child) {
    if (child.avatar.startsWith('http://') || child.avatar.startsWith('https://')) {
        return child.avatar;
    }
    const encodedName = encodeURIComponent(child.name || 'Child');
    return `https://ui-avatars.com/api/?name=${encodedName}&background=E2E8F0&color=334155&size=256&rounded=true`;
}
function formatDateTimeCn(iso) {
    const date = new Date(iso);
    return {
        date: date.toLocaleDateString('zh-CN'),
        time: date.toLocaleTimeString('zh-CN', { hour12: false })
    };
}
function resolveActorDisplay(source, actorUserId) {
    const sourceLabels = {
        admin: '管理员',
        operator: '操作员',
        bot: '飞书用户',
        schedule: '定时任务',
        mcp: 'MCP工具'
    };
    if (!actorUserId) {
        return sourceLabels[source] ?? source;
    }
    const actor = store.getSnapshot().users.find((u) => u.id === actorUserId || u.username === actorUserId || u.boundFeishuUserId === actorUserId);
    return actor?.username ?? actorUserId;
}
function buildBalanceSnapshotCardPayload(child) {
    const latest = [...store.getSnapshot().transactions]
        .filter((item) => item.childId === child.id)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    const basePayload = {
        title: '余额查询结果',
        lines: []
    };
    if (!latest) {
        basePayload.lines = [
            `**对象**：${child.name}`,
            `💰 **当前余额**：${child.balance.toFixed(2)}元`,
            `**说明**：暂无历史变动记录`
        ];
        return basePayload;
    }
    const actorDisplay = resolveActorDisplay(latest.source, latest.actorUserId);
    const { date, time } = formatDateTimeCn(latest.createdAt);
    basePayload.lines = [
        `**对象**：${child.name}`,
        `💰 **最近变动金额**：${amountWithSign(latest.amount)}元   |   **当前余额**：${child.balance.toFixed(2)}元`,
        `**变动原因**：${latest.reason}`,
        `**变动时间**：${date} ${time}`,
        `**变动操作人**：${actorDisplay}`
    ];
    const templateId = process.env.FEISHU_MONEY_CHANGE_TEMPLATE_ID?.trim();
    if (templateId) {
        basePayload.templateId = templateId;
        basePayload.templateVariable = {
            child_avatar: resolveAvatarForFeishu(child),
            child_name: child.name,
            balance_after: `${child.balance.toFixed(2)}元`,
            change_amount: `${amountWithSign(latest.amount)}元`,
            change_reason: latest.reason,
            change_date: date,
            change_time: time,
            operator_name: actorDisplay,
            transaction_type: latest.type,
            transaction_source: latest.source
        };
    }
    return basePayload;
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
    const actorDisplay = resolveActorDisplay(input.source, input.actorUserId);
    const updatedChild = store.getSnapshot().children.find((item) => item.id === input.childId);
    const currentBalance = updatedChild?.balance ?? child.balance;
    const { date, time } = formatDateTimeCn(transaction.createdAt);
    const payload = {
        title: '零花钱金额变动通知',
        lines: [
            `**对象**：${child.name}`,
            `💰 **变动金额**：${amountWithSign(input.amount)}元   |   **变动后余额**：${currentBalance.toFixed(2)}元`,
            `**变动原因**：${input.reason}`,
            `**变动时间**：${date} ${time}`,
            `**变动操作人**：${actorDisplay}`
        ],
        // 携带撤销按钮，用户可在 30 分钟内点击撤销此次操作
        actions: [{
                text: '↩ 撤销此操作',
                type: 'danger',
                value: { action: 'undo_transaction', transactionId: transaction.id, childId: input.childId, amount: input.amount }
            }]
    };
    // 若配置了模板 ID，优先走模板动态渲染
    const templateId = process.env.FEISHU_MONEY_CHANGE_TEMPLATE_ID?.trim();
    if (templateId) {
        payload.templateId = templateId;
        payload.templateVariable = {
            child_avatar: resolveAvatarForFeishu(child),
            child_name: child.name,
            balance_after: `${currentBalance.toFixed(2)}元`,
            change_amount: `${amountWithSign(input.amount)}元`,
            change_reason: input.reason,
            change_date: date,
            change_time: time,
            operator_name: actorDisplay,
            transaction_type: input.type,
            transaction_source: input.source
        };
    }
    const logRobot = store.getSnapshot().robots.find((r) => r.enabled && r.childIds.includes(input.childId))
        ?? store.getSnapshot().robots[0];
    try {
        const messageId = await sendRobotCard(payload, input.chatIdOverride, input.childId);
        if (logRobot) {
            pushBotLog({
                id: nanoid(),
                robotId: logRobot.id,
                time: new Date().toISOString(),
                direction: 'out',
                msgType: 'interactive',
                messageId,
                cardTitle: payload.title,
                status: 'ok'
            });
        }
    }
    catch (error) {
        if (logRobot) {
            pushBotLog({
                id: nanoid(),
                robotId: logRobot.id,
                time: new Date().toISOString(),
                direction: 'out',
                msgType: 'interactive',
                cardTitle: payload.title,
                status: 'failed',
                error: error instanceof Error ? error.message : '消息发送失败'
            });
        }
        throw error;
    }
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
function resolveMatchedRobots(senderOpenId) {
    return store.getSnapshot().robots.filter((robot) => {
        if (!robot.enabled) {
            return false;
        }
        if (robot.controllerOpenIds.length > 0 && !robot.controllerOpenIds.includes(senderOpenId)) {
            return false;
        }
        return true;
    });
}
function resolveDiagnosticRobot(chatId) {
    const enabledRobots = store.getSnapshot().robots.filter((r) => r.enabled);
    if (enabledRobots.length === 0) {
        return undefined;
    }
    if (chatId) {
        const exact = enabledRobots.find((r) => r.lastActiveChatId === chatId || r.feishuDefaultChatId === chatId);
        if (exact) {
            return exact;
        }
    }
    return enabledRobots[0];
}
function pushWebhookRejectLog(req, reason) {
    const { senderOpenId, messageType, contentRaw, chatId } = extractFeishuEvent(req.body);
    const robot = resolveDiagnosticRobot(chatId);
    if (!robot) {
        return;
    }
    const preview = contentRaw ? extractMessageText(contentRaw, messageType).trim().slice(0, 160) : undefined;
    pushBotLog({
        id: nanoid(),
        robotId: robot.id,
        time: new Date().toISOString(),
        direction: 'in',
        senderOpenId,
        chatId,
        rawText: preview,
        status: 'failed',
        error: reason
    });
}
function pickRobotForAction(robots, chatId, childName) {
    if (robots.length <= 1) {
        return robots[0];
    }
    if (chatId) {
        const exact = robots.find((robot) => robot.lastActiveChatId === chatId || robot.feishuDefaultChatId === chatId);
        if (exact) {
            return exact;
        }
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
let wsClientConnecting = false;
let wsClientAppId;
let wsClientLastReadyAt;
let wsClientLastError;
let wsClientLastReconnectingAt;
let wsClientLastReconnectedAt;
let wsClient;
async function initFeishuWsClient() {
    // 仅使用启用且 app 模式的机器人建立 WS 长连接
    const robot = store.getSnapshot().robots.find((r) => r.enabled && r.feishuMode !== 'webhook' && r.feishuAppId && r.feishuAppSecret);
    const appId = robot?.feishuAppId;
    const appSecret = robot?.feishuAppSecret;
    const robotId = robot?.id;
    if (!appId || !appSecret) {
        console.log('[飞书WS] appId 或 appSecret 未配置，跳过长连接初始化');
        return;
    }
    if (wsClientConnecting) {
        console.log('[飞书WS] 正在连接中，跳过重复初始化');
        return;
    }
    if (wsClientStarted) {
        if (wsClientAppId && wsClientAppId !== appId) {
            console.log('[飞书WS] 检测到 AppID 变更，当前进程仍使用旧连接，需重启服务后生效');
        }
        else {
            console.log('[飞书WS] 已启动，若需更新配置请重启服务');
        }
        return;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const eventDispatcher = new Lark.EventDispatcher({}).register({
            'im.message.receive_v1': async (data) => {
                const { senderOpenId, senderType, messageType, contentRaw, chatId, messageId } = extractFeishuEvent(data);
                if (chatId && robotId) {
                    store.update((draft) => {
                        const r = draft.robots.find((item) => item.id === robotId);
                        if (r)
                            r.lastActiveChatId = chatId;
                    });
                }
                try {
                    await processBotMessage(senderOpenId, senderType, messageType, contentRaw, chatId, messageId);
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
        wsClientConnecting = true;
        wsClientLastError = undefined;
        wsClient = new Lark.WSClient({
            appId,
            appSecret,
            onReady: () => {
                wsClientStarted = true;
                wsClientConnecting = false;
                wsClientAppId = appId;
                wsClientLastReadyAt = new Date().toISOString();
                wsClientLastError = undefined;
                console.log(`[飞书WS] 长连接握手成功，AppID: ${appId}`);
            },
            onError: (err) => {
                wsClientStarted = false;
                wsClientConnecting = false;
                wsClientLastError = err.message;
                console.error('[飞书WS] 连接失败:', err);
            },
            onReconnecting: () => {
                wsClientStarted = false;
                wsClientLastReconnectingAt = new Date().toISOString();
                console.warn('[飞书WS] 连接中断，进入重连中');
            },
            onReconnected: () => {
                wsClientStarted = true;
                wsClientLastReconnectedAt = new Date().toISOString();
                wsClientLastError = undefined;
                console.log('[飞书WS] 重连成功');
            }
        });
        await wsClient.start({ eventDispatcher });
        // start 结束后若仍未 ready，至少清理连接中状态，避免后续无法重试
        if (!wsClientStarted) {
            wsClientConnecting = false;
            console.warn('[飞书WS] start 已返回但尚未 ready，等待 SDK 回调');
        }
    }
    catch (error) {
        wsClientConnecting = false;
        wsClientStarted = false;
        wsClientLastError = error instanceof Error ? error.message : 'WS 启动失败';
        console.error('[飞书WS] 启动失败:', error);
    }
}
// 服务启动后初始化飞书 WS 连接
void initFeishuWsClient();
// 启动时若有模型余额为空，立即获取一次
if (store.getAllModels().some((m) => m.provider === 'deepseek' && m.apiKey && m.balance === undefined)) {
    void checkModelBalances();
}
app.get('/api/version', (_req, res) => {
    res.json({ success: true, version: '0.3.17' });
});
app.get('/api/feishu/ws-status', requireAuth, requireRole('admin'), (_req, res) => {
    const reconnectInfo = wsClient?.getReconnectInfo();
    res.json({
        success: true,
        data: {
            started: wsClientStarted,
            connecting: wsClientConnecting,
            appId: wsClientAppId,
            lastReadyAt: wsClientLastReadyAt,
            lastError: wsClientLastError,
            lastReconnectingAt: wsClientLastReconnectingAt,
            lastReconnectedAt: wsClientLastReconnectedAt,
            reconnectInfo
        }
    });
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
    const { name, enabled, childIds, controllerOpenIds, feishuMode, feishuAppId, feishuAppSecret, feishuWebhookUrl, feishuVerificationToken, feishuSigningSecret, feishuDefaultChatId } = req.body;
    const normalizedName = String(name ?? '').trim();
    const normalizedChildIds = normalizeStringArray(childIds);
    const normalizedControllerOpenIds = normalizeStringArray(controllerOpenIds);
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
    // 新增机器人后立即尝试初始化 WS，避免“启动时未配置”导致后续不接收消息
    void initFeishuWsClient();
    res.json({ success: true, data: robot });
});
app.put('/api/robots/:robotId', requireAuth, requireRole('admin'), (req, res) => {
    const { robotId } = req.params;
    const { name, enabled, childIds, controllerOpenIds, feishuMode, feishuAppId, feishuAppSecret, feishuWebhookUrl, feishuVerificationToken, feishuSigningSecret, feishuDefaultChatId } = req.body;
    const exists = store.getSnapshot().robots.some((item) => item.id === robotId);
    if (!exists) {
        res.status(404).json({ success: false, error: '机器人不存在' });
        return;
    }
    const normalizedName = name === undefined ? undefined : String(name).trim();
    const normalizedChildIds = childIds === undefined ? undefined : normalizeStringArray(childIds);
    const normalizedControllerOpenIds = controllerOpenIds === undefined ? undefined : normalizeStringArray(controllerOpenIds);
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
    // 更新机器人后立即尝试初始化 WS，确保新增凭证可在当前进程生效
    void initFeishuWsClient();
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
// 查询机器人运行日志（内存，最多 200 条，倒序）
app.get('/api/robots/:robotId/logs', requireAuth, requireRole('admin'), (req, res) => {
    const { robotId } = req.params;
    const logs = botLogs.get(robotId) ?? [];
    res.json({ success: true, data: [...logs].reverse() });
});
// 获取机器人所在的飞书群列表（调用飞书 im/v1/chats API，返回机器人实际加入的群）
app.get('/api/robots/:robotId/chats', requireAuth, requireRole('admin'), async (req, res) => {
    const { robotId } = req.params;
    const robot = store.getSnapshot().robots.find((r) => r.id === robotId);
    if (!robot) {
        res.status(404).json({ success: false, error: '机器人不存在' });
        return;
    }
    if (!robot.feishuAppId || !robot.feishuAppSecret) {
        res.status(400).json({ success: false, error: '该机器人未配置 App ID 或 App Secret，无法查询群列表' });
        return;
    }
    try {
        // 第一步：获取 tenant_access_token
        const tokenResp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ app_id: robot.feishuAppId, app_secret: robot.feishuAppSecret })
        });
        const tokenData = await tokenResp.json();
        if (tokenData.code !== 0 || !tokenData.tenant_access_token) {
            res.status(400).json({ success: false, error: `获取飞书 token 失败：${tokenData.msg}` });
            return;
        }
        // 第二步：获取机器人实际加入的群列表（im/v1/chats，不需要 query 参数）
        const allItems = [];
        let pageToken;
        do {
            const params = new URLSearchParams({ page_size: '100' });
            if (pageToken)
                params.set('page_token', pageToken);
            const chatResp = await fetch(`https://open.feishu.cn/open-apis/im/v1/chats?${params.toString()}`, {
                headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` }
            });
            const chatData = await chatResp.json();
            if (chatData.code !== 0) {
                res.status(400).json({ success: false, error: `查询群列表失败：${chatData.msg}` });
                return;
            }
            for (const item of chatData.data?.items ?? []) {
                allItems.push(item);
            }
            pageToken = chatData.data?.has_more ? chatData.data.page_token : undefined;
        } while (pageToken);
        const items = allItems.map((item) => ({ chatId: item.chat_id, name: item.name }));
        res.json({ success: true, data: items });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : '请求失败';
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
    // 兼容旧端点更新飞书配置后，立即尝试初始化 WS
    void initFeishuWsClient();
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
async function processBotMessage(senderOpenId, senderType, messageType, contentRaw, chatId, messageId) {
    const diagnosticRobot = resolveDiagnosticRobot(chatId);
    const previewText = contentRaw ? extractMessageText(contentRaw, messageType).trim().slice(0, 160) : undefined;
    const logIgnoredInbound = (reason) => {
        if (!diagnosticRobot) {
            return;
        }
        pushBotLog({
            id: nanoid(),
            robotId: diagnosticRobot.id,
            time: new Date().toISOString(),
            direction: 'in',
            senderOpenId,
            chatId,
            rawText: previewText,
            status: 'ignored',
            error: reason
        });
    };
    if (senderType === 'bot') {
        logIgnoredInbound('ignored_sender_type_bot');
        return null;
    }
    if (!senderOpenId) {
        logIgnoredInbound('ignored_missing_sender_open_id');
        return null;
    }
    if (!contentRaw) {
        logIgnoredInbound('ignored_missing_message_content');
        return null;
    }
    if (!shouldProcessInboundMessage(messageId)) {
        logIgnoredInbound(`ignored_duplicate_message_id:${messageId}`);
        return null;
    }
    if (messageType && messageType !== 'text' && messageType !== 'post') {
        logIgnoredInbound(`ignored_unsupported_message_type:${messageType}`);
        return null;
    }
    if (store.getSnapshot().config.ignoreBotUserIds.includes(senderOpenId)) {
        logIgnoredInbound('ignored_by_ignoreBotUserIds');
        return null;
    }
    const matchedRobots = resolveMatchedRobots(senderOpenId ?? '');
    if (matchedRobots.length === 0) {
        logIgnoredInbound('ignored_no_matched_robot_or_controller_openid_not_allowed');
        return null;
    }
    const text = extractMessageText(contentRaw, messageType).trim();
    if (!text) {
        logIgnoredInbound('ignored_empty_text_after_extract');
        return null;
    }
    // 选一个代表机器人用于日志归属（首选绑定了当前 chatId 对应小孩的机器人）
    const primaryRobot = pickRobotForAction(matchedRobots, chatId) ?? matchedRobots[0];
    // 写入"收到消息"日志
    const inLogId = nanoid();
    pushBotLog({
        id: inLogId,
        robotId: primaryRobot.id,
        time: new Date().toISOString(),
        direction: 'in',
        senderOpenId,
        chatId,
        rawText: text,
        status: 'ok'
    });
    let action = parsePreciseBotCommand(text);
    const matchedByPrecise = Boolean(action);
    if (!action) {
        const parserModel = resolveParserModelConfig();
        try {
            action = await parseBotAction(text, parserModel.apiKey, parserModel.apiUrl, parserModel.modelId);
        }
        catch (err) {
            // AI 调用失败，更新入站日志状态，发送失败卡片
            const list = botLogs.get(primaryRobot.id);
            const inLog = list?.find((l) => l.id === inLogId);
            if (inLog) {
                inLog.status = 'failed';
                inLog.error = err instanceof Error ? err.message : 'AI 调用失败';
            }
            try {
                const msgId = await sendRobotCard({
                    title: '⚠️ 消息识别失败',
                    lines: [
                        `**原始消息**：${text}`,
                        `**失败原因**：AI 模型调用异常，请检查模型配置`
                    ],
                    color: 'red'
                }, chatId);
                pushBotLog({
                    id: nanoid(),
                    robotId: primaryRobot.id,
                    time: new Date().toISOString(),
                    direction: 'out',
                    chatId,
                    messageId: msgId,
                    msgType: 'interactive',
                    cardTitle: '⚠️ 消息识别失败',
                    status: 'ok'
                });
            }
            catch { /* 通知失败不抛出 */ }
            throw err;
        }
        // 仅 AI 路径下异步刷新余额，不阻塞主流程
        void checkModelBalances();
    }
    if (!action) {
        return null;
    }
    // AI 路径不依赖 childName，由机器人绑定关系决定目标孩子。
    if (!matchedByPrecise) {
        action.childName = undefined;
    }
    // 更新入站日志的识别意图
    const list = botLogs.get(primaryRobot.id);
    const inLog = list?.find((l) => l.id === inLogId);
    if (inLog)
        inLog.intent = action.intent;
    if (action.intent === 'unknown') {
        if (inLog)
            inLog.status = 'unrecognized';
        // 发送识别失败反馈卡片
        try {
            const msgId = await sendRobotCard({
                title: '❓ 指令无法识别',
                lines: [
                    `**原始消息**：${text}`,
                    `**提示**：支持操作包括发放零花钱、余额增减、查询余额、设置额度/奖励/周报时间；输入“帮助”可查看完整说明。`
                ],
                color: 'orange'
            }, chatId);
            pushBotLog({
                id: nanoid(),
                robotId: primaryRobot.id,
                time: new Date().toISOString(),
                direction: 'out',
                chatId,
                messageId: msgId,
                msgType: 'interactive',
                cardTitle: '❓ 指令无法识别',
                status: 'ok'
            });
        }
        catch { /* 通知失败不阻断 */ }
        return null;
    }
    const robot = pickRobotForAction(matchedRobots, chatId, action.childName);
    if (!robot)
        return null;
    const targetChild = resolveChildFromAction(action, robot);
    if (!targetChild && action.intent !== 'set_weekly_notify') {
        throw new Error('未找到目标小孩或无权限');
    }
    try {
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
                const msgId = await sendRobotCard({
                    title: '系统操作反馈：每日额度调整',
                    lines: [
                        `**识别结果**：成功`,
                        `**对象**：${targetChild.name}`,
                        `**每日零花钱总金额**：${amountYuan(action.amount)}`
                    ]
                }, chatId, targetChild.id);
                pushBotLog({ id: nanoid(), robotId: robot.id, time: new Date().toISOString(), direction: 'out', chatId, messageId: msgId, msgType: 'interactive', cardTitle: '系统操作反馈：每日额度调整', status: 'ok' });
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
                const msgId = await sendRobotCard({
                    title: '系统操作反馈：额外奖励设置',
                    lines: [
                        `**识别结果**：成功`,
                        `**对象**：${targetChild.name}`,
                        `**奖励项目**：${action.rewardKeyword}`,
                        `**奖励金额**：${amountYuan(action.amount)}`
                    ]
                }, chatId, targetChild.id);
                pushBotLog({ id: nanoid(), robotId: robot.id, time: new Date().toISOString(), direction: 'out', chatId, messageId: msgId, msgType: 'interactive', cardTitle: '系统操作反馈：额外奖励设置', status: 'ok' });
                break;
            }
            case 'deduct_expense': {
                if (!targetChild || action.amount === undefined)
                    throw new Error('缺少参数');
                await applyTransaction({
                    childId: targetChild.id,
                    amount: -Math.abs(action.amount),
                    reason: action.reason ?? '消费',
                    type: 'expense',
                    source: 'bot',
                    actorUserId: senderOpenId,
                    chatIdOverride: chatId
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
                const msgId = await sendRobotCard({
                    title: '系统操作反馈：每周统计通知',
                    lines: [
                        `**识别结果**：成功`,
                        `**通知时间**：每周一 ${String(action.hour).padStart(2, '0')}:${String(action.minute).padStart(2, '0')}`
                    ]
                }, chatId);
                pushBotLog({ id: nanoid(), robotId: robot.id, time: new Date().toISOString(), direction: 'out', chatId, messageId: msgId, msgType: 'interactive', cardTitle: '系统操作反馈：每周统计通知', status: 'ok' });
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
                    amount: Math.abs(reward.amount),
                    reason: action.reason ?? `完成${reward.keyword}`,
                    type: 'reward',
                    source: 'bot',
                    actorUserId: senderOpenId,
                    chatIdOverride: chatId
                });
                break;
            }
            case 'manual_grant_daily_allowance': {
                if (!targetChild)
                    throw new Error('未找到目标小孩或无权限');
                await applyTransaction({
                    childId: targetChild.id,
                    amount: targetChild.dailyAllowance,
                    reason: '手动发放零花钱',
                    type: 'daily',
                    source: 'bot',
                    actorUserId: senderOpenId,
                    chatIdOverride: chatId
                });
                const today = new Date().toISOString().slice(0, 10);
                store.update((draft) => {
                    if (!draft.config.lastDailyGrantTimes) {
                        draft.config.lastDailyGrantTimes = {};
                    }
                    draft.config.lastDailyGrantTimes[targetChild.id] = today;
                });
                break;
            }
            case 'increase_balance': {
                if (!targetChild || action.amount === undefined)
                    throw new Error('缺少参数');
                await applyTransaction({
                    childId: targetChild.id,
                    amount: Math.abs(action.amount),
                    reason: '手动余额增加',
                    type: 'manual',
                    source: 'bot',
                    actorUserId: senderOpenId,
                    chatIdOverride: chatId
                });
                break;
            }
            case 'decrease_balance': {
                if (!targetChild || action.amount === undefined)
                    throw new Error('缺少参数');
                await applyTransaction({
                    childId: targetChild.id,
                    amount: -Math.abs(action.amount),
                    reason: '手动余额减少',
                    type: 'manual',
                    source: 'bot',
                    actorUserId: senderOpenId,
                    chatIdOverride: chatId
                });
                break;
            }
            case 'query_balance': {
                if (!targetChild)
                    throw new Error('未找到目标小孩或无权限');
                const payload = buildBalanceSnapshotCardPayload(targetChild);
                const msgId = await sendRobotCard(payload, chatId, targetChild.id);
                pushBotLog({
                    id: nanoid(),
                    robotId: robot.id,
                    time: new Date().toISOString(),
                    direction: 'out',
                    chatId,
                    messageId: msgId,
                    msgType: 'interactive',
                    cardTitle: payload.title,
                    status: 'ok'
                });
                break;
            }
            case 'show_help': {
                const payload = {
                    title: '指令说明',
                    lines: [
                        `**精确指令（格式正确即立即执行，不走 AI）**`,
                        `1. 发放零花钱`,
                        `2. 余额增加：n 或 +n（中英文冒号都支持）`,
                        `3. 余额减少：n 或 -n（中英文冒号都支持）`,
                        `4. 查询余额 / 余额`,
                        `5. 帮助 / 指令 / 说明`,
                        `\n**自然语言说明**`,
                        `带有消费信息或复杂描述的对话会进入 AI 识别，例如：\"扣掉5元，因为初始金额设置错误\"。`,
                        `若精确指令和 AI 都未识别，将返回“指令无法识别”的反馈。`
                    ],
                    color: 'blue'
                };
                const msgId = await sendRobotCard(payload, chatId, targetChild?.id);
                pushBotLog({
                    id: nanoid(),
                    robotId: robot.id,
                    time: new Date().toISOString(),
                    direction: 'out',
                    chatId,
                    messageId: msgId,
                    msgType: 'interactive',
                    cardTitle: payload.title,
                    status: 'ok'
                });
                break;
            }
            default:
                break;
        }
    }
    catch (error) {
        const errMsg = error instanceof Error ? error.message : '操作失败';
        if (inLog) {
            inLog.status = 'failed';
            inLog.error = errMsg;
        }
        try {
            const suggestion = errMsg.includes('飞书应用消息发送失败') || errMsg.includes('access_token')
                ? '指令已识别，但结果回传失败；请检查机器人会话 Chat ID、应用消息权限和群可见范围'
                : '请检查金额格式或当前机器人权限配置';
            const msgId = await sendRobotCard({
                title: '⚠️ 指令处理失败',
                lines: [
                    `**原始消息**：${text}`,
                    `**失败原因**：${errMsg}`,
                    `**建议**：${suggestion}`
                ],
                color: 'red'
            }, chatId);
            pushBotLog({
                id: nanoid(),
                robotId: robot.id,
                time: new Date().toISOString(),
                direction: 'out',
                chatId,
                messageId: msgId,
                msgType: 'interactive',
                cardTitle: '⚠️ 指令处理失败',
                status: 'failed',
                error: errMsg
            });
        }
        catch {
            // 回传失败仅记录日志，不中断
        }
        return null;
    }
    return action;
}
app.post(['/api/feishu/webhook', '/api/feishu/events'], async (req, res) => {
    if (!verifyFeishuToken(req.body)) {
        pushWebhookRejectLog(req, 'webhook_token_verify_failed');
        res.status(401).json({ success: false, error: '飞书 token 校验失败' });
        return;
    }
    if (!verifyFeishuSignature(req)) {
        pushWebhookRejectLog(req, 'webhook_signature_verify_failed');
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
    const { senderOpenId, senderType, messageType, contentRaw, chatId, messageId } = extractFeishuEvent(req.body);
    if (chatId) {
        // 更新第一个启用的 app 模式机器人（webhook 端点通常对应单一机器人）
        const matchedRobot = store.getSnapshot().robots.find((r) => r.enabled && r.feishuMode !== 'webhook');
        if (matchedRobot) {
            store.update((draft) => {
                const r = draft.robots.find((item) => item.id === matchedRobot.id);
                if (r)
                    r.lastActiveChatId = chatId;
            });
        }
    }
    try {
        const action = await processBotMessage(senderOpenId, senderType, messageType, contentRaw, chatId, messageId);
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
