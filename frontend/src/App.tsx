import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import {
  adjustChild,
  createChild,
  createModel,
  createPrompt,
  createRobot,
  deleteChild,
  deleteModel,
  deletePrompt,
  deleteRobot,
  discoverModels,
  getChildren,
  getConfig,
  getModels,
  getPrompts,
  getRobots,
  getSetupStatus,
  getTransactions,
  getWeeklySummaries,
  initAdmin,
  login,
  logout,
  me,
  setDailyAllowance,
  setRewardRule,
  setWeeklyNotify,
  updateChild,
  updateModel,
  updatePrompt,
  updateRobot,
  updateSystemConfig
} from './api';
import { ChildProfile, ModelConfig, MoneyTransaction, PromptTemplate, RobotConfig, SystemConfig, UserInfo, WeeklySummary } from './types';

const DEFAULT_AVATAR = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" fill="#E2E8F0"/><circle cx="64" cy="50" r="24" fill="#94A3B8"/><rect x="26" y="84" width="76" height="30" rx="15" fill="#94A3B8"/></svg>'
)}`;

type NavTab = 'stats' | 'models' | 'robots' | 'children';
type NoticeType = 'success' | 'error' | 'info' | 'warning';
type RobotView = { mode: 'list' } | { mode: 'create' } | { mode: 'edit'; robotId: string };
type ChildView = { mode: 'list' } | { mode: 'create' } | { mode: 'edit'; childId: string };

interface NoticeItem {
  id: number;
  type: NoticeType;
  message: string;
}

interface RobotDraft {
  name: string;
  enabled: boolean;
  childIds: string[];
  controllerOpenIdsText: string;
  allowedChatIdsText: string;
}

interface ChildDraft {
  name: string;
  avatar: string;
  dailyAllowance: number;
}

interface ModelDraft {
  name: string;
  provider: ModelConfig['provider'];
  apiUrl: string;
  apiKey: string;
  modelId: string;
}

interface PromptDraft {
  name: string;
  purpose: PromptTemplate['purpose'];
  content: string;
}

interface LedgerRow {
  id: string;
  childId: string;
  childName: string;
  amount: number;
  createdAt: string;
  typeLabel: string;
  reason: string;
  balanceAfter: number;
}

const NAV_ITEMS: Array<{ key: NavTab; label: string; icon: string }> = [
  { key: 'stats', label: '统计', icon: 'stats' },
  { key: 'models', label: '模型', icon: 'model' },
  { key: 'robots', label: '机器人', icon: 'robot' },
  { key: 'children', label: '孩子', icon: 'child' }
];

function compressImage(file: File, maxSide = 280, quality = 0.82): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('无法创建图像处理上下文'));
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('头像读取失败，请重试'));
    };
    img.src = url;
  });
}

function parseTextList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

function formatMoney(amount: number): string {
  const prefix = amount > 0 ? '+' : '';
  return `${prefix}${amount.toFixed(2)}元`;
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function getTransactionTypeLabel(type: MoneyTransaction['type']): string {
  switch (type) {
    case 'daily':
      return '每日发放';
    case 'reward':
      return '奖励';
    case 'expense':
      return '消费';
    case 'manual':
      return '手动调整';
    default:
      return '金额变动';
  }
}

function getModelStatusLabel(status: ModelConfig['status']): string {
  switch (status) {
    case 'connected':
      return '已连接';
    case 'testing':
      return '测试中';
    case 'disconnected':
      return '已断开';
    case 'unconfigured':
      return '未配置';
    default:
      return '未知状态';
  }
}

function createEmptyRobotDraft(): RobotDraft {
  return {
    name: '',
    enabled: true,
    childIds: [],
    controllerOpenIdsText: '',
    allowedChatIdsText: ''
  };
}

function createEmptyChildDraft(defaultDailyAllowance: number): ChildDraft {
  return {
    name: '',
    avatar: '',
    dailyAllowance: defaultDailyAllowance
  };
}

function createModelDraft(provider: ModelConfig['provider'] = 'deepseek'): ModelDraft {
  const defaultApiUrlByProvider: Record<ModelConfig['provider'], string> = {
    deepseek: 'https://api.deepseek.com',
    openai: 'https://api.openai.com',
    google: 'https://generativelanguage.googleapis.com',
    custom: ''
  };

  return {
    name: '',
    provider,
    apiUrl: defaultApiUrlByProvider[provider],
    apiKey: '',
    modelId: ''
  };
}

function createPromptDraft(): PromptDraft {
  return {
    name: '',
    purpose: 'vscode-chat',
    content: ''
  };
}

function AppIcon(props: { name: string; size?: number; className?: string }) {
  const size = props.size ?? 20;
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: props.className
  };

  switch (props.name) {
    case 'stats':
      return (
        <svg {...common}>
          <path d="M4 19h16" />
          <path d="M7 16v-5" />
          <path d="M12 16V8" />
          <path d="M17 16v-9" />
        </svg>
      );
    case 'model':
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="16" rx="3" />
          <path d="M9 9h6" />
          <path d="M9 12h6" />
          <path d="M9 15h3" />
        </svg>
      );
    case 'robot':
      return (
        <svg {...common}>
          <rect x="7" y="8" width="10" height="9" rx="2" />
          <path d="M12 4v4" />
          <path d="M9 17v2" />
          <path d="M15 17v2" />
          <circle cx="10" cy="12" r="1" />
          <circle cx="14" cy="12" r="1" />
        </svg>
      );
    case 'child':
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="3" />
          <path d="M6 19a6 6 0 0 1 12 0" />
        </svg>
      );
    case 'plus':
      return (
        <svg {...common}>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
      );
    case 'edit':
      return (
        <svg {...common}>
          <path d="M4 20h4l10-10-4-4L4 16v4z" />
          <path d="M13 7l4 4" />
        </svg>
      );
    case 'logout':
      return (
        <svg {...common}>
          <path d="M14 16l4-4-4-4" />
          <path d="M18 12H9" />
          <path d="M11 19H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
        </svg>
      );
    case 'back':
      return (
        <svg {...common}>
          <path d="M15 6l-6 6 6 6" />
        </svg>
      );
    case 'success':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M8.5 12.5l2.2 2.2 4.8-5" />
        </svg>
      );
    case 'error':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M9 9l6 6" />
          <path d="M15 9l-6 6" />
        </svg>
      );
    case 'info':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 10v5" />
          <path d="M12 7h.01" />
        </svg>
      );
    case 'warning':
      return (
        <svg {...common}>
          <path d="M12 3l9 16H3l9-16z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
        </svg>
      );
  }
}

function NotificationViewport(props: { notices: NoticeItem[]; onClose: (id: number) => void }) {
  return (
    <div className="toast-stack" aria-live="polite" aria-atomic="true">
      {props.notices.map((notice) => (
        <div key={notice.id} className={`toast toast--${notice.type}`}>
          <div className="toast__icon">
            <AppIcon name={notice.type} size={18} />
          </div>
          <div className="toast__message">{notice.message}</div>
          <button type="button" className="toast__close" onClick={() => props.onClose(notice.id)}>
            <span aria-hidden="true">x</span>
          </button>
        </div>
      ))}
    </div>
  );
}

function App() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [children, setChildren] = useState<ChildProfile[]>([]);
  const [robots, setRobots] = useState<RobotConfig[]>([]);
  const [transactions, setTransactions] = useState<MoneyTransaction[]>([]);
  const [summaries, setSummaries] = useState<WeeklySummary[]>([]);
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [prompts, setPrompts] = useState<PromptTemplate[]>([]);
  const [adminInitialized, setAdminInitialized] = useState<boolean | null>(null);
  const [activeTab, setActiveTab] = useState<NavTab>('stats');
  const [defaultDailyAllowance, setDefaultDailyAllowance] = useState(10);
  const [notices, setNotices] = useState<NoticeItem[]>([]);

  const [loginUsername, setLoginUsername] = useState('admin');
  const [loginPassword, setLoginPassword] = useState('admin');
  const [initUsername, setInitUsername] = useState('admin');
  const [initPassword, setInitPassword] = useState('admin');

  const [robotView, setRobotView] = useState<RobotView>({ mode: 'list' });
  const [robotDraft, setRobotDraft] = useState<RobotDraft>(createEmptyRobotDraft());

  const [childView, setChildView] = useState<ChildView>({ mode: 'list' });
  const [childDraft, setChildDraft] = useState<ChildDraft>(createEmptyChildDraft(10));
  const [childAdjustAmount, setChildAdjustAmount] = useState(0);
  const [childAdjustReason, setChildAdjustReason] = useState('发放零花钱');
  const [childRewardKeyword, setChildRewardKeyword] = useState('家务');
  const [childRewardAmount, setChildRewardAmount] = useState(5);
  const [childFormKey, setChildFormKey] = useState(0);

  const [modelDraft, setModelDraft] = useState<ModelDraft>(createModelDraft());
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [discoveredModelIds, setDiscoveredModelIds] = useState<string[]>([]);
  const [discoveringModels, setDiscoveringModels] = useState(false);

  const [promptDraft, setPromptDraft] = useState<PromptDraft>(createPromptDraft());
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);

  const [notifyHour, setNotifyHour] = useState(20);
  const [notifyMinute, setNotifyMinute] = useState(0);
  const [feishuMode, setFeishuMode] = useState<'app' | 'webhook'>('app');
  const [feishuWebhookUrl, setFeishuWebhookUrl] = useState('');
  const [feishuAppId, setFeishuAppId] = useState('');
  const [feishuAppSecret, setFeishuAppSecret] = useState('');
  const [feishuVerificationToken, setFeishuVerificationToken] = useState('');
  const [feishuSigningSecret, setFeishuSigningSecret] = useState('');
  const [feishuDefaultChatId, setFeishuDefaultChatId] = useState('');
  const [lastActiveChatId, setLastActiveChatId] = useState('');

  const noticeTimers = useRef<Record<number, number>>({});

  const childMap = useMemo(() => new Map(children.map((item) => [item.id, item])), [children]);

  const robotNameMapByChildId = useMemo(() => {
    const result = new Map<string, string[]>();
    robots.forEach((robot) => {
      robot.childIds.forEach((childId) => {
        const current = result.get(childId) ?? [];
        current.push(robot.name);
        result.set(childId, current);
      });
    });
    return result;
  }, [robots]);

  const totalBalance = useMemo(() => children.reduce((sum, child) => sum + child.balance, 0), [children]);

  const ledgerRows = useMemo<LedgerRow[]>(() => {
    const balances = new Map<string, number>();
    const ascending = [...transactions].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());

    const rows = ascending.map((tx) => {
      const nextBalance = (balances.get(tx.childId) ?? 0) + tx.amount;
      balances.set(tx.childId, nextBalance);
      return {
        id: tx.id,
        childId: tx.childId,
        childName: childMap.get(tx.childId)?.name ?? tx.childId,
        amount: tx.amount,
        createdAt: tx.createdAt,
        typeLabel: getTransactionTypeLabel(tx.type),
        reason: tx.reason,
        balanceAfter: nextBalance
      };
    });

    return rows.reverse();
  }, [childMap, transactions]);

  const latestWeeklySummaries = useMemo(() => summaries.slice(0, 3), [summaries]);

  const selectedRobot = useMemo(() => {
    return robotView.mode === 'edit' ? robots.find((item) => item.id === robotView.robotId) ?? null : null;
  }, [robotView, robots]);

  const selectedChild = useMemo(() => {
    return childView.mode === 'edit' ? children.find((item) => item.id === childView.childId) ?? null : null;
  }, [childView, children]);

  useEffect(() => {
    return () => {
      Object.values(noticeTimers.current).forEach((timerId) => window.clearTimeout(timerId));
    };
  }, []);

  function dismissNotice(id: number): void {
    if (noticeTimers.current[id]) {
      window.clearTimeout(noticeTimers.current[id]);
      delete noticeTimers.current[id];
    }
    setNotices((current) => current.filter((item) => item.id !== id));
  }

  function showNotice(message: string, type: NoticeType = 'success'): void {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setNotices((current) => [...current, { id, message, type }]);
    noticeTimers.current[id] = window.setTimeout(() => dismissNotice(id), 3200);
  }

  function handleRequestError(error: unknown): void {
    showNotice((error as Error).message, 'error');
  }

  async function reloadData(currentUser: UserInfo): Promise<void> {
    const [childList, transactionList, weeklyList, modelList, promptList, config] = await Promise.all([
      getChildren(),
      getTransactions(),
      getWeeklySummaries(),
      getModels(),
      getPrompts(),
      getConfig()
    ]);

    setChildren(childList);
    setTransactions(transactionList);
    setSummaries(weeklyList);
    setModels(modelList);
    setPrompts(promptList);
    setDefaultDailyAllowance(config.defaultDailyAllowance ?? 10);
    setNotifyHour(config.weeklyNotify?.hour ?? 20);
    setNotifyMinute(config.weeklyNotify?.minute ?? 0);
    setFeishuMode(config.feishuMode ?? 'app');
    setFeishuWebhookUrl(config.feishuWebhookUrl ?? '');
    setFeishuAppId(config.feishuAppId ?? '');
    setFeishuAppSecret(config.feishuAppSecret ?? '');
    setFeishuVerificationToken(config.feishuVerificationToken ?? '');
    setFeishuSigningSecret(config.feishuSigningSecret ?? '');
    setFeishuDefaultChatId(config.feishuDefaultChatId ?? '');
    setLastActiveChatId(config.lastActiveChatId ?? '');

    if (currentUser.role === 'admin') {
      const robotList = await getRobots();
      setRobots(robotList);
    } else {
      setRobots([]);
    }
  }

  useEffect(() => {
    getSetupStatus()
      .then((status) => setAdminInitialized(status.adminInitialized))
      .catch(() => setAdminInitialized(false));

    me()
      .then(async (info) => {
        setUser(info);
        await reloadData(info);
      })
      .catch(() => {
        setUser(null);
      });
  }, []);

  function openCreateRobot(): void {
    setRobotDraft(createEmptyRobotDraft());
    setRobotView({ mode: 'create' });
  }

  function openEditRobot(robot: RobotConfig): void {
    setRobotDraft({
      name: robot.name,
      enabled: robot.enabled,
      childIds: robot.childIds,
      controllerOpenIdsText: robot.controllerOpenIds.join('\n'),
      allowedChatIdsText: robot.allowedChatIds.join('\n')
    });
    setRobotView({ mode: 'edit', robotId: robot.id });
  }

  function closeRobotEditor(): void {
    setRobotView({ mode: 'list' });
    setRobotDraft(createEmptyRobotDraft());
  }

  function openCreateChild(): void {
    setChildDraft(createEmptyChildDraft(defaultDailyAllowance));
    setChildAdjustAmount(0);
    setChildAdjustReason('发放零花钱');
    setChildRewardKeyword('家务');
    setChildRewardAmount(5);
    setChildFormKey((value) => value + 1);
    setChildView({ mode: 'create' });
  }

  function openEditChild(child: ChildProfile): void {
    setChildDraft({
      name: child.name,
      avatar: child.avatar,
      dailyAllowance: child.dailyAllowance
    });
    setChildAdjustAmount(0);
    setChildAdjustReason('发放零花钱');
    setChildRewardKeyword(child.rewardRules[0]?.keyword ?? '家务');
    setChildRewardAmount(child.rewardRules[0]?.amount ?? 5);
    setChildFormKey((value) => value + 1);
    setChildView({ mode: 'edit', childId: child.id });
  }

  function closeChildEditor(): void {
    setChildView({ mode: 'list' });
    setChildDraft(createEmptyChildDraft(defaultDailyAllowance));
  }

  async function handleLoginSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      const info = await login(loginUsername.trim(), loginPassword);
      setUser(info);
      await reloadData(info);
      showNotice('登录成功');
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function handleInitSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      const username = initUsername.trim();
      await initAdmin(username, initPassword);
      setAdminInitialized(true);
      setLoginUsername(username);
      setLoginPassword(initPassword);
      showNotice('管理员初始化成功，请继续登录');
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function handleRobotSave(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!user) {
      return;
    }

    const payload = {
      name: robotDraft.name.trim(),
      enabled: robotDraft.enabled,
      childIds: robotDraft.childIds,
      controllerOpenIds: parseTextList(robotDraft.controllerOpenIdsText),
      allowedChatIds: parseTextList(robotDraft.allowedChatIdsText)
    };

    try {
      if (robotView.mode === 'edit') {
        await updateRobot(robotView.robotId, payload);
        showNotice('机器人配置已更新');
      } else {
        await createRobot(payload);
        showNotice('机器人已创建');
      }
      await reloadData(user);
      closeRobotEditor();
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function handleRobotDelete(): Promise<void> {
    if (!user || robotView.mode !== 'edit') {
      return;
    }

    if (!window.confirm('确认删除这个机器人吗？')) {
      return;
    }

    try {
      await deleteRobot(robotView.robotId);
      await reloadData(user);
      closeRobotEditor();
      showNotice('机器人已删除', 'warning');
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function handleChildSave(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!user) {
      return;
    }

    try {
      if (childView.mode === 'edit') {
        await updateChild(childView.childId, {
          name: childDraft.name.trim(),
          avatar: childDraft.avatar
        });
        await setDailyAllowance(childView.childId, childDraft.dailyAllowance);
        showNotice('孩子信息已更新');
      } else {
        await createChild({
          name: childDraft.name.trim(),
          avatar: childDraft.avatar,
          dailyAllowance: childDraft.dailyAllowance
        });
        showNotice('孩子已创建');
      }

      await reloadData(user);
      closeChildEditor();
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function handleChildDelete(): Promise<void> {
    if (!user || childView.mode !== 'edit') {
      return;
    }

    if (!window.confirm('确认删除这个孩子吗？')) {
      return;
    }

    try {
      await deleteChild(childView.childId);
      await reloadData(user);
      closeChildEditor();
      showNotice('孩子已删除', 'warning');
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function handleChildAdjustment(): Promise<void> {
    if (!user || childView.mode !== 'edit') {
      return;
    }

    try {
      await adjustChild(childView.childId, {
        amount: childAdjustAmount,
        reason: childAdjustReason.trim() || '金额调整'
      });
      await reloadData(user);
      setChildAdjustAmount(0);
      setChildAdjustReason('发放零花钱');
      showNotice('金额调整已完成');
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function handleChildRewardRule(): Promise<void> {
    if (!user || childView.mode !== 'edit') {
      return;
    }

    try {
      await setRewardRule(childView.childId, childRewardKeyword.trim(), childRewardAmount);
      await reloadData(user);
      showNotice('奖励规则已更新');
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function handleDiscoverModels(): Promise<void> {
    if (!modelDraft.apiKey.trim()) {
      showNotice('请先填写 API Key', 'warning');
      return;
    }

    setDiscoveringModels(true);
    try {
      const list = await discoverModels(modelDraft.provider, modelDraft.apiUrl, modelDraft.apiKey);
      setDiscoveredModelIds(list);
      if (!modelDraft.modelId && list.length > 0) {
        setModelDraft((current) => ({ ...current, modelId: list[0] }));
      }
      showNotice(`已获取 ${list.length} 个模型`, 'info');
    } catch (error) {
      handleRequestError(error);
    } finally {
      setDiscoveringModels(false);
    }
  }

  async function handleModelSave(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!user) {
      return;
    }

    try {
      if (editingModelId) {
        await updateModel(editingModelId, {
          name: modelDraft.name.trim(),
          provider: modelDraft.provider,
          apiUrl: modelDraft.apiUrl.trim(),
          apiKey: modelDraft.apiKey.trim() || undefined,
          modelId: modelDraft.modelId.trim()
        });
        showNotice('模型配置已更新');
      } else {
        await createModel({
          name: modelDraft.name.trim(),
          provider: modelDraft.provider,
          apiUrl: modelDraft.apiUrl.trim(),
          apiKey: modelDraft.apiKey.trim(),
          modelId: modelDraft.modelId.trim(),
          isBuiltIn: false,
          status: 'unconfigured'
        });
        showNotice('模型配置已新增');
      }

      setEditingModelId(null);
      setModelDraft(createModelDraft());
      setDiscoveredModelIds([]);
      await reloadData(user);
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function handlePromptSave(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!user) {
      return;
    }

    try {
      const payload = {
        name: promptDraft.name.trim(),
        purpose: promptDraft.purpose,
        content: promptDraft.content,
        isBuiltIn: false,
        usageCount: 0
      };

      if (editingPromptId) {
        await updatePrompt(editingPromptId, payload);
        showNotice('MCP 模板已更新');
      } else {
        await createPrompt(payload);
        showNotice('MCP 模板已新增');
      }

      setEditingPromptId(null);
      setPromptDraft(createPromptDraft());
      await reloadData(user);
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function handleSaveFeishuConfig(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!user) {
      return;
    }

    try {
      const payload: Partial<SystemConfig> = {
        feishuMode,
        feishuWebhookUrl: feishuWebhookUrl.trim(),
        feishuAppId: feishuAppId.trim(),
        feishuAppSecret: feishuAppSecret.trim(),
        feishuVerificationToken: feishuVerificationToken.trim(),
        feishuSigningSecret: feishuSigningSecret.trim(),
        feishuDefaultChatId: feishuDefaultChatId.trim()
      };

      await updateSystemConfig(payload);
      await reloadData(user);
      showNotice('飞书配置已保存');
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function handleSaveWeeklyNotify(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!user) {
      return;
    }

    try {
      await setWeeklyNotify(notifyHour, notifyMinute);
      showNotice('周报通知时间已保存');
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function handleAvatarUpload(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const avatar = await compressImage(file);
      setChildDraft((current) => ({ ...current, avatar }));
      showNotice('头像已压缩并更新', 'info');
    } catch (error) {
      handleRequestError(error);
    }
  }

  function renderStatsPage() {
    return (
      <div className="page-stack">
        <section className="hero-panel">
          <div>
            <p className="hero-panel__eyebrow">资金总览</p>
            <h1 className="hero-panel__title">每一笔零花钱变化都在这里</h1>
            <p className="hero-panel__desc">最新记录置顶展示，按孩子逐笔回算余额，方便你快速核对每次变动后的真实剩余。</p>
          </div>
          <div className="metric-grid">
            <article className="metric-card">
              <span className="metric-card__label">当前总余额</span>
              <strong className="metric-card__value">{totalBalance.toFixed(2)}元</strong>
            </article>
            <article className="metric-card">
              <span className="metric-card__label">孩子数量</span>
              <strong className="metric-card__value">{children.length}</strong>
            </article>
            <article className="metric-card">
              <span className="metric-card__label">机器人数量</span>
              <strong className="metric-card__value">{robots.length}</strong>
            </article>
          </div>
        </section>

        {latestWeeklySummaries.length > 0 && (
          <section className="panel-card">
            <div className="panel-card__header">
              <div>
                <p className="section-eyebrow">近期周统计</p>
                <h2>自动汇总摘要</h2>
              </div>
            </div>
            <div className="summary-grid">
              {latestWeeklySummaries.map((summary) => (
                <article className="summary-card" key={summary.id}>
                  <div className="summary-card__title">{childMap.get(summary.childId)?.name ?? summary.childId}</div>
                  <div className="summary-card__meta">{summary.weekStartDate} - {summary.weekEndDate}</div>
                  <div className="summary-card__line">增加 {summary.increasedAmount.toFixed(2)}元</div>
                  <div className="summary-card__line">消费 {summary.expenseAmount.toFixed(2)}元</div>
                  <div className="summary-card__line">结余 {summary.remainingAmount.toFixed(2)}元</div>
                  <div className="summary-card__hint">{summary.aiSuggestion}</div>
                </article>
              ))}
            </div>
          </section>
        )}

        <section className="panel-card">
          <div className="panel-card__header">
            <div>
              <p className="section-eyebrow">金额流水</p>
              <h2>所有金额变动记录</h2>
            </div>
            <span className="panel-card__badge">共 {ledgerRows.length} 条</span>
          </div>

          <div className="ledger-table">
            <div className="ledger-table__head">
              <span>日期</span>
              <span>金额</span>
              <span>项目</span>
              <span>余额</span>
            </div>
            <div className="ledger-table__body">
              {ledgerRows.map((row) => (
                <article className="ledger-row" key={row.id}>
                  <div className="ledger-row__cell">
                    <div className="ledger-row__primary">{formatDateTime(row.createdAt)}</div>
                    <div className="ledger-row__sub">{row.childName}</div>
                  </div>
                  <div className={`ledger-row__cell ledger-row__amount ${row.amount >= 0 ? 'is-positive' : 'is-negative'}`}>
                    {formatMoney(row.amount)}
                  </div>
                  <div className="ledger-row__cell">
                    <div className="ledger-row__primary">{row.typeLabel}</div>
                    <div className="ledger-row__sub">{row.reason}</div>
                  </div>
                  <div className="ledger-row__cell">
                    <div className="ledger-row__primary">{row.balanceAfter.toFixed(2)}元</div>
                    <div className="ledger-row__sub">变动后余额</div>
                  </div>
                </article>
              ))}

              {ledgerRows.length === 0 && <div className="empty-card">暂无金额流水，等第一笔变动出现后会在这里汇总。</div>}
            </div>
          </div>
        </section>
      </div>
    );
  }

  function renderModelsPage() {
    return (
      <div className="page-stack">
        <section className="panel-card">
          <div className="panel-card__header">
            <div>
              <p className="section-eyebrow">模型配置</p>
              <h2>模型与 MCP 服务</h2>
            </div>
          </div>

          {user?.role !== 'admin' ? (
            <div className="empty-card">当前账号没有模型配置权限。</div>
          ) : (
            <>
              <form className="form-grid" onSubmit={handleModelSave}>
                <div className="form-row">
                  <label>
                    配置名称
                    <input value={modelDraft.name} onChange={(event) => setModelDraft((current) => ({ ...current, name: event.target.value }))} required />
                  </label>
                  <label>
                    服务商
                    <select
                      value={modelDraft.provider}
                      onChange={(event) => {
                        const provider = event.target.value as ModelConfig['provider'];
                        setEditingModelId(null);
                        setModelDraft(createModelDraft(provider));
                        setDiscoveredModelIds([]);
                      }}
                    >
                      <option value="deepseek">DeepSeek</option>
                      <option value="openai">OpenAI</option>
                      <option value="google">Google</option>
                      <option value="custom">自定义</option>
                    </select>
                  </label>
                </div>

                <div className="form-row">
                  <label>
                    API 地址
                    <input value={modelDraft.apiUrl} onChange={(event) => setModelDraft((current) => ({ ...current, apiUrl: event.target.value }))} required />
                  </label>
                  <label>
                    API Key
                    <input type="password" value={modelDraft.apiKey} onChange={(event) => setModelDraft((current) => ({ ...current, apiKey: event.target.value }))} placeholder={editingModelId ? '留空表示不修改' : ''} />
                  </label>
                </div>

                <div className="form-row form-row--tight">
                  <label>
                    模型 ID
                    <input value={modelDraft.modelId} onChange={(event) => setModelDraft((current) => ({ ...current, modelId: event.target.value }))} required />
                  </label>
                  <button type="button" className="secondary-button" onClick={handleDiscoverModels} disabled={discoveringModels}>
                    {discoveringModels ? '获取中...' : '通过 API 拉取模型'}
                  </button>
                </div>

                {discoveredModelIds.length > 0 && (
                  <label>
                    自动发现的模型
                    <select value={modelDraft.modelId} onChange={(event) => setModelDraft((current) => ({ ...current, modelId: event.target.value }))}>
                      {discoveredModelIds.map((modelId) => (
                        <option key={modelId} value={modelId}>{modelId}</option>
                      ))}
                    </select>
                  </label>
                )}

                <div className="action-row">
                  <button type="submit">{editingModelId ? '保存模型配置' : '新增模型配置'}</button>
                  {editingModelId && (
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => {
                        setEditingModelId(null);
                        setModelDraft(createModelDraft());
                        setDiscoveredModelIds([]);
                      }}
                    >
                      取消编辑
                    </button>
                  )}
                </div>
              </form>

              <div className="stack-list">
                {models.map((model) => (
                  <article className="list-card" key={model.id}>
                    <div>
                      <div className="list-card__title">{model.name}</div>
                      <div className="list-card__meta">{model.provider} · {model.modelId || '未设置模型 ID'} · {getModelStatusLabel(model.status)}</div>
                    </div>
                    <div className="list-card__actions">
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => {
                          setEditingModelId(model.id);
                          setModelDraft({
                            name: model.name,
                            provider: model.provider,
                            apiUrl: model.apiUrl,
                            apiKey: '',
                            modelId: model.modelId ?? ''
                          });
                          setDiscoveredModelIds([]);
                        }}
                      >
                        编辑
                      </button>
                      {!model.isBuiltIn && (
                        <button
                          type="button"
                          className="danger-button"
                          onClick={async () => {
                            if (!user || !window.confirm('确认删除这个模型配置吗？')) {
                              return;
                            }
                            try {
                              await deleteModel(model.id);
                              await reloadData(user);
                              showNotice('模型配置已删除', 'warning');
                            } catch (error) {
                              handleRequestError(error);
                            }
                          }}
                        >
                          删除
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
        </section>

        <section className="panel-card">
          <div className="panel-card__header">
            <div>
              <p className="section-eyebrow">MCP 模板</p>
              <h2>提示词与服务模板</h2>
            </div>
          </div>

          {user?.role === 'admin' && (
            <form className="form-grid" onSubmit={handlePromptSave}>
              <div className="form-row">
                <label>
                  模板名称
                  <input value={promptDraft.name} onChange={(event) => setPromptDraft((current) => ({ ...current, name: event.target.value }))} required />
                </label>
                <label>
                  用途
                  <select value={promptDraft.purpose} onChange={(event) => setPromptDraft((current) => ({ ...current, purpose: event.target.value as PromptTemplate['purpose'] }))}>
                    <option value="vscode-chat">工作总结</option>
                    <option value="daily">日报快报</option>
                    <option value="weekly">周报总结</option>
                    <option value="incident">事件报告</option>
                    <option value="optimization">优化建议</option>
                    <option value="pocket-money">零花钱识别</option>
                    <option value="custom">自定义</option>
                  </select>
                </label>
              </div>
              <label>
                模板内容
                <textarea value={promptDraft.content} onChange={(event) => setPromptDraft((current) => ({ ...current, content: event.target.value }))} rows={8} required />
              </label>
              <div className="action-row">
                <button type="submit">{editingPromptId ? '保存模板' : '新增模板'}</button>
                {editingPromptId && (
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => {
                      setEditingPromptId(null);
                      setPromptDraft(createPromptDraft());
                    }}
                  >
                    取消编辑
                  </button>
                )}
              </div>
            </form>
          )}

          <div className="stack-list">
            {prompts.map((prompt) => (
              <article className="list-card list-card--vertical" key={prompt.id}>
                <div className="list-card__title-row">
                  <div>
                    <div className="list-card__title">{prompt.name}</div>
                    <div className="list-card__meta">{prompt.purpose} · {prompt.isBuiltIn ? '内置' : '自定义'}</div>
                  </div>
                  {user?.role === 'admin' && (
                    <div className="list-card__actions">
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => {
                          setEditingPromptId(prompt.id);
                          setPromptDraft({
                            name: prompt.name,
                            purpose: prompt.purpose,
                            content: prompt.content
                          });
                        }}
                      >
                        编辑
                      </button>
                      {!prompt.isBuiltIn && (
                        <button
                          type="button"
                          className="danger-button"
                          onClick={async () => {
                            if (!user || !window.confirm('确认删除这个模板吗？')) {
                              return;
                            }
                            try {
                              await deletePrompt(prompt.id);
                              await reloadData(user);
                              showNotice('模板已删除', 'warning');
                            } catch (error) {
                              handleRequestError(error);
                            }
                          }}
                        >
                          删除
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <div className="template-preview">{prompt.content}</div>
              </article>
            ))}
          </div>
        </section>
      </div>
    );
  }

  function renderRobotList() {
    return (
      <div className="page-stack page-stack--with-fab">
        <section className="hero-panel hero-panel--compact">
          <div>
            <p className="hero-panel__eyebrow">机器人矩阵</p>
            <h1 className="hero-panel__title">每个机器人只管理属于自己的孩子和群组</h1>
            <p className="hero-panel__desc">先选机器人，再进入详情维护它的孩子绑定、控制账号 OpenID 和允许触发的飞书群或会话。</p>
          </div>
        </section>

        <section className="panel-card">
          <div className="panel-card__header">
            <div>
              <p className="section-eyebrow">机器人列表</p>
              <h2>全部机器人</h2>
            </div>
            <span className="panel-card__badge">{robots.length} 个机器人</span>
          </div>

          {robots.length === 0 ? (
            <div className="empty-card">还没有机器人，点击右下角按钮先创建一个。</div>
          ) : (
            <div className="stack-list">
              {robots.map((robot) => (
                <article className="list-card" key={robot.id}>
                  <div>
                    <div className="list-card__title">{robot.name}</div>
                    <div className="list-card__meta">
                      {robot.enabled ? '启用中' : '已停用'} · 绑定孩子 {robot.childIds.length} 个 · 控制账号 {robot.controllerOpenIds.length} 个
                    </div>
                  </div>
                  <div className="list-card__actions">
                    <button type="button" className="ghost-button" onClick={() => openEditRobot(robot)}>进入详情</button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        {user?.role === 'admin' && (
          <>
            <section className="panel-card">
              <div className="panel-card__header">
                <div>
                  <p className="section-eyebrow">飞书机器人设置</p>
                  <h2>接入凭证与回调配置</h2>
                </div>
              </div>
              <form className="form-grid" onSubmit={handleSaveFeishuConfig}>
                <label>
                  飞书接入方式
                  <select value={feishuMode} onChange={(event) => setFeishuMode(event.target.value as 'app' | 'webhook')}>
                    <option value="app">自建应用事件订阅（推荐）</option>
                    <option value="webhook">群 webhook</option>
                  </select>
                  <span className="field-hint">推荐「自建应用事件订阅」，可同时接收单聊和群聊消息；「群 webhook」仅支持群消息推送</span>
                </label>

                <div className="form-row">
                  <label>
                    飞书 App ID
                    <input value={feishuAppId} onChange={(event) => setFeishuAppId(event.target.value)} placeholder="cli_xxxxxxxxxxxxxxxxxx" />
                    <span className="field-hint">飞书开放平台 → 应用详情 → 凭证与基础信息 → App ID</span>
                  </label>
                  <label>
                    飞书 App Secret
                    <input type="password" value={feishuAppSecret} onChange={(event) => setFeishuAppSecret(event.target.value)} placeholder="••••••••" />
                    <span className="field-hint">同页面的 App Secret，切勿泄露</span>
                  </label>
                </div>

                <div className="form-row">
                  <label>
                    Verification Token
                    <input value={feishuVerificationToken} onChange={(event) => setFeishuVerificationToken(event.target.value)} placeholder="xxxxxxxxxxxxxxxxxxxxxxxx" />
                    <span className="field-hint">开放平台 → 事件订阅 → 加密策略 → Verification Token</span>
                  </label>
                  <label>
                    Signing Secret
                    <input type="password" value={feishuSigningSecret} onChange={(event) => setFeishuSigningSecret(event.target.value)} placeholder="••••••••" />
                    <span className="field-hint">同页面的 Encrypt Key / Signing Secret</span>
                  </label>
                </div>

                <label>
                  默认通知 Chat ID
                  <input value={feishuDefaultChatId} onChange={(event) => setFeishuDefaultChatId(event.target.value)} placeholder="oc_xxxxxxxxxxxxxxxxxxxxxxxx" />
                  <span className="field-hint">机器人主动推送消息的目标群 Chat ID（oc_xxx）。在群内发任意消息后，下方「最近活跃 Chat ID」会自动更新</span>
                </label>

                {feishuMode === 'webhook' && (
                  <label>
                    群 webhook 地址
                    <input value={feishuWebhookUrl} onChange={(event) => setFeishuWebhookUrl(event.target.value)} placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." />
                    <span className="field-hint">仅 webhook 模式需要，在飞书群设置 → 机器人 → 添加机器人中获取</span>
                  </label>
                )}

                {lastActiveChatId ? (
                  <label>
                    最近活跃 Chat ID（只读）
                    <input value={lastActiveChatId} readOnly />
                  </label>
                ) : null}

                <button type="submit">保存飞书配置</button>
              </form>
            </section>

            <section className="panel-card">
              <div className="panel-card__header">
                <div>
                  <p className="section-eyebrow">周报通知</p>
                  <h2>每周统计发送时间</h2>
                </div>
              </div>
              <form className="form-grid" onSubmit={handleSaveWeeklyNotify}>
                <label>
                  每周发送时间（每周一自动推送）
                  <input
                    type="time"
                    value={`${String(notifyHour).padStart(2, '0')}:${String(notifyMinute).padStart(2, '0')}`}
                    onChange={(event) => {
                      const parts = event.target.value.split(':');
                      if (parts.length === 2) {
                        setNotifyHour(Number(parts[0]));
                        setNotifyMinute(Number(parts[1]));
                      }
                    }}
                  />
                  <span className="field-hint">每周一该时间点自动向默认 Chat ID 发送上周零花钱统计汇总</span>
                </label>
                <button type="submit">保存通知时间</button>
              </form>
            </section>
          </>
        )}

        {user?.role === 'admin' && (
          <button type="button" className="fab-button" onClick={openCreateRobot}>
            <AppIcon name="plus" size={22} />
            <span>新增机器人</span>
          </button>
        )}
      </div>
    );
  }

  function renderRobotEditor() {
    const title = robotView.mode === 'create' ? '新增机器人' : selectedRobot?.name ?? '机器人详情';

    return (
      <div className="page-stack">
        <section className="detail-header">
          <button type="button" className="back-button" onClick={closeRobotEditor}>
            <AppIcon name="back" size={18} />
            <span>返回列表</span>
          </button>
          <div>
            <p className="section-eyebrow">机器人详情</p>
            <h1>{title}</h1>
          </div>
        </section>

        <section className="panel-card">
          <form className="form-grid" onSubmit={handleRobotSave}>
            <div className="form-row">
              <label>
                机器人名称
                <input value={robotDraft.name} onChange={(event) => setRobotDraft((current) => ({ ...current, name: event.target.value }))} required />
              </label>
              <label>
                状态
                <select value={robotDraft.enabled ? 'enabled' : 'disabled'} onChange={(event) => setRobotDraft((current) => ({ ...current, enabled: event.target.value === 'enabled' }))}>
                  <option value="enabled">启用</option>
                  <option value="disabled">停用</option>
                </select>
              </label>
            </div>

            <div>
              <span className="field-title">绑定孩子</span>
              <div className="chip-grid">
                {children.map((child) => {
                  const checked = robotDraft.childIds.includes(child.id);
                  return (
                    <label className={`chip-option ${checked ? 'is-active' : ''}`} key={child.id}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setRobotDraft((current) => ({
                            ...current,
                            childIds: checked ? current.childIds.filter((item) => item !== child.id) : [...current.childIds, child.id]
                          }));
                        }}
                      />
                      <span>{child.name}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="form-row">
              <label>
                可控制账号 OpenID
                <textarea value={robotDraft.controllerOpenIdsText} onChange={(event) => setRobotDraft((current) => ({ ...current, controllerOpenIdsText: event.target.value }))} rows={6} required />
                <span className="field-hint">填写可控制该机器人的飞书用户 OpenID（ou_xxx），每行一个。可在飞书 App「我的」→「关于飞书」→「开发者工具」→「个人 OpenID」中查到</span>
              </label>
              <label>
                允许触发的 Chat ID
                <textarea value={robotDraft.allowedChatIdsText} onChange={(event) => setRobotDraft((current) => ({ ...current, allowedChatIdsText: event.target.value }))} rows={6} placeholder="留空表示所有会话都可触发" />
                <span className="field-hint">填写允许触发该机器人的飞书群/会话 Chat ID（oc_xxx），每行一个，留空则任意会话均可触发</span>
              </label>
            </div>

            <div className="action-row">
              <button type="submit">保存机器人</button>
              {robotView.mode === 'edit' && <button type="button" className="danger-button" onClick={handleRobotDelete}>删除机器人</button>}
            </div>
          </form>
        </section>
      </div>
    );
  }

  function renderChildrenList() {
    return (
      <div className="page-stack page-stack--with-fab">
        <section className="hero-panel hero-panel--compact">
          <div>
            <p className="hero-panel__eyebrow">孩子档案</p>
            <h1 className="hero-panel__title">头像、余额、绑定机器人一眼看清</h1>
            <p className="hero-panel__desc">点击卡片右侧编辑按钮进入孩子详情，可以继续修改孩子资料、调整金额、维护奖励规则或删除孩子。</p>
          </div>
        </section>

        <section className="card-grid">
          {children.map((child) => {
            const boundRobotNames = robotNameMapByChildId.get(child.id) ?? [];
            const avatarSrc = child.avatar || DEFAULT_AVATAR;
            return (
              <article className="child-card" key={child.id}>
                <img
                  src={avatarSrc}
                  alt={child.name}
                  className="child-card__avatar"
                  onError={(event) => {
                    event.currentTarget.src = DEFAULT_AVATAR;
                  }}
                />
                <div className="child-card__body">
                  <div className="child-card__title-row">
                    <div>
                      <h3>{child.name}</h3>
                      <p>{boundRobotNames.length > 0 ? boundRobotNames.join('、') : '未绑定'}</p>
                    </div>
                    {user?.role === 'admin' && (
                      <button type="button" className="icon-button" onClick={() => openEditChild(child)} aria-label={`编辑${child.name}`}>
                        <AppIcon name="edit" size={18} />
                      </button>
                    )}
                  </div>
                  <div className="child-card__balance">零钱余额 {child.balance.toFixed(2)}元</div>
                  <div className="child-card__daily">每日 {child.dailyAllowance.toFixed(2)}元</div>
                </div>
              </article>
            );
          })}

          {children.length === 0 && <div className="empty-card">还没有孩子档案，点击右下角按钮新增。</div>}
        </section>

        {user?.role === 'admin' && (
          <button type="button" className="fab-button" onClick={openCreateChild}>
            <AppIcon name="plus" size={22} />
            <span>新增孩子</span>
          </button>
        )}
      </div>
    );
  }

  function renderChildEditor() {
    const boundRobotNames = selectedChild ? robotNameMapByChildId.get(selectedChild.id) ?? [] : [];
    const avatarSrc = childDraft.avatar || DEFAULT_AVATAR;

    return (
      <div className="page-stack">
        <section className="detail-header">
          <button type="button" className="back-button" onClick={closeChildEditor}>
            <AppIcon name="back" size={18} />
            <span>返回列表</span>
          </button>
          <div>
            <p className="section-eyebrow">孩子详情</p>
            <h1>{childView.mode === 'create' ? '新增孩子' : selectedChild?.name ?? '孩子详情'}</h1>
          </div>
        </section>

        <section className="panel-card">
          <form className="form-grid" onSubmit={handleChildSave}>
            <div className="profile-head">
              <img
                src={avatarSrc}
                alt={childDraft.name || '孩子头像'}
                className="profile-head__avatar"
                onError={(event) => {
                  event.currentTarget.src = DEFAULT_AVATAR;
                }}
              />
              <div className="profile-head__info">
                <strong>{childDraft.name || '未命名孩子'}</strong>
                <span>{childView.mode === 'edit' ? (boundRobotNames.length > 0 ? `绑定机器人：${boundRobotNames.join('、')}` : '绑定机器人：未绑定') : '保存后即可出现在孩子列表中'}</span>
              </div>
            </div>

            <div className="form-row">
              <label>
                姓名
                <input value={childDraft.name} onChange={(event) => setChildDraft((current) => ({ ...current, name: event.target.value }))} required />
              </label>
              <label>
                每日额度
                <input type="number" min={0} step="0.1" value={childDraft.dailyAllowance} onChange={(event) => setChildDraft((current) => ({ ...current, dailyAllowance: Number(event.target.value) }))} />
              </label>
            </div>

            <label>
              头像上传（可选）
              <input key={childFormKey} type="file" accept="image/*" onChange={handleAvatarUpload} />
              <span className="field-hint">支持 JPG / PNG / WebP 等常见格式，任意大小均自动缩放至 280×280 并压缩后上传，无需手动处理</span>
            </label>

            <div className="action-row">
              <button type="submit">保存孩子信息</button>
              {childView.mode === 'edit' && <button type="button" className="danger-button" onClick={handleChildDelete}>删除孩子</button>}
            </div>
          </form>
        </section>

        {childView.mode === 'edit' && selectedChild && (
          <>
            <section className="panel-card">
              <div className="panel-card__header">
                <div>
                  <p className="section-eyebrow">金额调整</p>
                  <h2>直接改余额</h2>
                </div>
              </div>
              <div className="form-grid">
                <div className="form-row">
                  <label>
                    增减金额
                    <input type="number" step="0.1" value={childAdjustAmount} onChange={(event) => setChildAdjustAmount(Number(event.target.value))} />
                  </label>
                  <label>
                    项目说明
                    <input value={childAdjustReason} onChange={(event) => setChildAdjustReason(event.target.value)} />
                  </label>
                </div>
                <button type="button" onClick={handleChildAdjustment}>提交金额变动</button>
              </div>
            </section>

            <section className="panel-card">
              <div className="panel-card__header">
                <div>
                  <p className="section-eyebrow">奖励规则</p>
                  <h2>维护奖励项目</h2>
                </div>
              </div>
              <div className="form-grid">
                <div className="form-row">
                  <label>
                    奖励项目
                    <input value={childRewardKeyword} onChange={(event) => setChildRewardKeyword(event.target.value)} />
                  </label>
                  <label>
                    奖励金额
                    <input type="number" min={0.1} step="0.1" value={childRewardAmount} onChange={(event) => setChildRewardAmount(Number(event.target.value))} />
                  </label>
                </div>
                <button type="button" onClick={handleChildRewardRule}>保存奖励规则</button>
                {selectedChild.rewardRules.length > 0 && (
                  <div className="chip-wrap">
                    {selectedChild.rewardRules.map((rule) => (
                      <span key={rule.id} className="reward-chip">{rule.keyword} +{rule.amount}元</span>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </>
        )}
      </div>
    );
  }

  function renderAppBody() {
    if (activeTab === 'stats') {
      return renderStatsPage();
    }

    if (activeTab === 'models') {
      return renderModelsPage();
    }

    if (activeTab === 'robots') {
      if (user?.role !== 'admin') {
        return <div className="empty-card">当前账号没有机器人配置权限。</div>;
      }
      return robotView.mode === 'list' ? renderRobotList() : renderRobotEditor();
    }

    if (user?.role !== 'admin' && childView.mode !== 'list') {
      return <div className="empty-card">当前账号没有孩子编辑权限。</div>;
    }

    return childView.mode === 'list' ? renderChildrenList() : renderChildEditor();
  }

  if (!user) {
    const showInitCard = adminInitialized === false;
    const showLoginCard = adminInitialized === true;

    return (
      <div className="auth-shell">
        <div className="auth-panel">
          <div className="auth-panel__hero">
            <p className="section-eyebrow">Feishu Pocket</p>
            <h1>零花钱助手后台</h1>
            <p>按统一层级重构后的移动管理面板，先登录，再配置模型、机器人与孩子。</p>
          </div>

          {showInitCard && (
            <form className="panel-card form-grid" onSubmit={handleInitSubmit}>
              <div>
                <p className="section-eyebrow">首次使用</p>
                <h2>初始化管理员</h2>
              </div>
              <label>
                用户名
                <input value={initUsername} onChange={(event) => setInitUsername(event.target.value)} required />
              </label>
              <label>
                密码
                <input type="password" value={initPassword} onChange={(event) => setInitPassword(event.target.value)} required />
              </label>
              <button type="submit">初始化并继续</button>
            </form>
          )}

          {showLoginCard && (
            <form className="panel-card form-grid" onSubmit={handleLoginSubmit}>
              <div>
                <p className="section-eyebrow">账号登录</p>
                <h2>进入后台</h2>
              </div>
              <label>
                用户名
                <input value={loginUsername} onChange={(event) => setLoginUsername(event.target.value)} required />
              </label>
              <label>
                密码
                <input type="password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} required />
              </label>
              <button type="submit">登录系统</button>
            </form>
          )}

          {adminInitialized === null && <div className="panel-card">正在检查初始化状态...</div>}
        </div>

        <NotificationViewport notices={notices} onClose={dismissNotice} />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar-card">
        <div>
          <p className="section-eyebrow">Pocket Console</p>
          <h1>飞书零花钱助手</h1>
        </div>
        <div className="topbar-card__actions">
          <div className="user-chip">
            <span className="user-chip__dot" />
            <span>{user.role === 'admin' ? '管理员' : '成员'} · {user.username}</span>
          </div>
          <button
            type="button"
            className="icon-text-button"
            onClick={() => {
              logout();
              setUser(null);
              showNotice('已退出登录', 'info');
            }}
          >
            <AppIcon name="logout" size={18} />
            <span>退出</span>
          </button>
        </div>
      </header>

      <main className="content-shell">{renderAppBody()}</main>

      <nav className="bottom-nav" aria-label="主菜单">
        {NAV_ITEMS.map((item) => {
          const active = activeTab === item.key;
          return (
            <button key={item.key} type="button" className={`bottom-nav__item ${active ? 'is-active' : ''}`} onClick={() => setActiveTab(item.key)}>
              <AppIcon name={item.icon} size={20} />
              <span className="bottom-nav__label">{item.label}</span>
            </button>
          );
        })}
      </nav>

      <NotificationViewport notices={notices} onClose={dismissNotice} />
    </div>
  );
}

export default App;