import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from 'react';

import {
  adjustChild,
  createChild,
  discoverModels,
  createRobot,
  createModel,
  createPrompt,
  deleteRobot,
  deleteModel,
  deletePrompt,
  getChildren,
  getConfig,
  getModels,
  getRobots,
  getPrompts,
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
  updateSystemConfig,
  updateRobot,
  updateModel,
  updatePrompt
} from './api';
import { ChildProfile, ModelConfig, PromptTemplate, RobotConfig, SystemConfig, UserInfo, WeeklySummary } from './types';

const DEFAULT_AVATAR = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" fill="#E2E8F0"/><circle cx="64" cy="50" r="24" fill="#94A3B8"/><rect x="26" y="84" width="76" height="30" rx="15" fill="#94A3B8"/></svg>'
)}`;

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('头像读取失败，请重试'));
    reader.readAsDataURL(file);
  });
}

function App() {
  const defaultApiUrlByProvider: Record<ModelConfig['provider'], string> = {
    deepseek: 'https://api.deepseek.com',
    openai: 'https://api.openai.com',
    google: 'https://generativelanguage.googleapis.com',
    custom: ''
  };

  const [user, setUser] = useState<UserInfo | null>(null);
  const [children, setChildren] = useState<ChildProfile[]>([]);
  const [robots, setRobots] = useState<RobotConfig[]>([]);
  const [transactions, setTransactions] = useState<Array<{ id: string; childId: string; amount: number; reason: string; createdAt: string }>>([]);
  const [summaries, setSummaries] = useState<WeeklySummary[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [adminInitialized, setAdminInitialized] = useState<boolean | null>(null);

  const [loginUsername, setLoginUsername] = useState('admin');
  const [loginPassword, setLoginPassword] = useState('admin');
  const [initUsername, setInitUsername] = useState('admin');
  const [initPassword, setInitPassword] = useState('admin');

  const [newChildName, setNewChildName] = useState('');
  const [newChildAvatar, setNewChildAvatar] = useState('');
  const [newChildDaily, setNewChildDaily] = useState(10);

  const [newRobotName, setNewRobotName] = useState('');
  const [newRobotChildIds, setNewRobotChildIds] = useState<string[]>([]);
  const [newRobotControllerIds, setNewRobotControllerIds] = useState('');
  const [newRobotChatIds, setNewRobotChatIds] = useState('');
  const [newRobotEnabled, setNewRobotEnabled] = useState(true);

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

  const [models, setModels] = useState<ModelConfig[]>([]);
  const [prompts, setPrompts] = useState<PromptTemplate[]>([]);
  const [activeTab, setActiveTab] = useState<'children' | 'robots' | 'transactions' | 'models' | 'prompts' | 'summaries'>('children');
  const [newModelName, setNewModelName] = useState('');
  const [newModelProvider, setNewModelProvider] = useState<'openai' | 'deepseek' | 'google' | 'custom'>('deepseek');
  const [newModelUrl, setNewModelUrl] = useState('https://api.deepseek.com');
  const [newModelKey, setNewModelKey] = useState('');
  const [newModelId, setNewModelId] = useState('');
  const [discoveredModelIds, setDiscoveredModelIds] = useState<string[]>([]);
  const [discoveringModels, setDiscoveringModels] = useState(false);
  const [newPromptName, setNewPromptName] = useState('');
  const [newPromptPurpose, setNewPromptPurpose] = useState<'pocket-money' | 'vscode-chat' | 'daily' | 'weekly' | 'incident' | 'optimization' | 'custom'>('vscode-chat');
  const [newPromptContent, setNewPromptContent] = useState('');

  const childMap = useMemo(() => {
    return new Map(children.map((item) => [item.id, item]));
  }, [children]);

  const childNameMap = useMemo(() => {
    return new Map(children.map((item) => [item.name, item.id]));
  }, [children]);

  function parseTextList(value: string): string[] {
    return Array.from(
      new Set(
        value
          .split(/[,\n]/)
          .map((item) => item.trim())
          .filter(Boolean)
      )
    );
  }

  async function reloadData(currentUser: UserInfo): Promise<void> {
    const [childList, txList, weeklyList, modelList, promptList, config] = await Promise.all([
      getChildren(),
      getTransactions(),
      getWeeklySummaries(),
      getModels(),
      getPrompts(),
      getConfig()
    ]);
    setChildren(childList);
    setTransactions(txList);
    setSummaries(weeklyList);
    setModels(modelList);
    setPrompts(promptList);
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
      .then((status) => {
        setAdminInitialized(status.adminInitialized);
      })
      .catch(() => {
        setAdminInitialized(false);
      });

    me()
      .then(async (info) => {
        setUser(info);
        await reloadData(info);
      })
      .catch(() => {
        setUser(null);
      });
  }, []);

  function resetNotice(text: string): void {
    setError('');
    setMessage(text);
  }

  async function onLoginSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      const info = await login(loginUsername.trim(), loginPassword);
      setUser(info);
      await reloadData(info);
      resetNotice('登录成功');
    } catch (err) {
      setMessage('');
      setError((err as Error).message);
    }
  }

  async function onInitAdminSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      const normalizedUsername = initUsername.trim();
      await initAdmin(normalizedUsername, initPassword);
      setAdminInitialized(true);
      setLoginUsername(normalizedUsername);
      setLoginPassword(initPassword);
      resetNotice('管理员初始化成功，请使用刚设置的账号密码登录');
    } catch (err) {
      setMessage('');
      setError((err as Error).message);
    }
  }

  async function onCreateChild(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      await createChild({
        name: newChildName,
        avatar: newChildAvatar,
        dailyAllowance: newChildDaily
      });
      await reloadData(user as UserInfo);
      setNewChildName('');
      setNewChildAvatar('');
      setNewChildDaily(10);
      resetNotice('小孩创建成功');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onChildAvatarSelected(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) {
      setNewChildAvatar('');
      return;
    }

    // 头像可选，上传时限制 2MB，防止 store 文件过大。
    if (file.size > 2 * 1024 * 1024) {
      setError('头像文件不能超过2MB');
      event.target.value = '';
      return;
    }

    try {
      const avatarDataUrl = await fileToDataUrl(file);
      setNewChildAvatar(avatarDataUrl);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onCreateRobot(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      await createRobot({
        name: newRobotName.trim(),
        enabled: newRobotEnabled,
        childIds: newRobotChildIds,
        controllerOpenIds: parseTextList(newRobotControllerIds),
        allowedChatIds: parseTextList(newRobotChatIds)
      });
      setNewRobotName('');
      setNewRobotChildIds([]);
      setNewRobotControllerIds('');
      setNewRobotChatIds('');
      setNewRobotEnabled(true);
      if (user) {
        await reloadData(user);
      }
      resetNotice('机器人配置已创建');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onQuickEditRobot(robot: RobotConfig): Promise<void> {
    const childNames = robot.childIds.map((id) => childMap.get(id)?.name ?? id).join(',');
    const childInput = prompt('请输入要绑定的小孩姓名（逗号分隔）', childNames);
    if (childInput === null) {
      return;
    }

    const controllerInput = prompt('请输入可控制账号 OpenID（逗号分隔）', robot.controllerOpenIds.join(','));
    if (controllerInput === null) {
      return;
    }

    const chatInput = prompt('请输入允许触发的 Chat ID（逗号分隔，可留空表示不限）', robot.allowedChatIds.join(','));
    if (chatInput === null) {
      return;
    }

    const nextChildIds = parseTextList(childInput)
      .map((name) => childNameMap.get(name) ?? '')
      .filter(Boolean);

    if (nextChildIds.length === 0) {
      setError('机器人至少要绑定一个已存在的小孩姓名');
      return;
    }

    try {
      await updateRobot(robot.id, {
        childIds: nextChildIds,
        controllerOpenIds: parseTextList(controllerInput),
        allowedChatIds: parseTextList(chatInput)
      });
      if (user) {
        await reloadData(user);
      }
      resetNotice('机器人配置已更新');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onSaveWeeklyNotify(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      await setWeeklyNotify(notifyHour, notifyMinute);
      resetNotice('每周统计通知时间已更新');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onSaveFeishuBotConfig(event: FormEvent): Promise<void> {
    event.preventDefault();
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
      await reloadData(user as UserInfo);
      resetNotice('飞书机器人配置已保存');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onDiscoverProviderModels(): Promise<void> {
    if (!newModelKey.trim()) {
      setError('请先填写 API Key');
      return;
    }

    setDiscoveringModels(true);
    try {
      const modelsFromProvider = await discoverModels(newModelProvider, newModelUrl, newModelKey);
      setDiscoveredModelIds(modelsFromProvider);
      if (!newModelId && modelsFromProvider.length > 0) {
        setNewModelId(modelsFromProvider[0]);
      }
      resetNotice(`已获取 ${modelsFromProvider.length} 个模型`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDiscoveringModels(false);
    }
  }

  if (!user) {
    const showInitCard = adminInitialized === false;
    const showLoginCard = adminInitialized === true;

    return (
      <div className="mobile-shell">
        <div className="hero">
          <h1>飞书零花钱助手</h1>
          <p>群聊记账 + 管理后台 + MCP 自动操作</p>
        </div>

        {showInitCard && (
          <section className="card">
            <h2>管理员初始化（仅首次）</h2>
            <form onSubmit={onInitAdminSubmit} className="form-grid">
              <label>
                用户名（可自定义）
                <input value={initUsername} onChange={(e) => setInitUsername(e.target.value)} />
              </label>
              <label>
                密码
                <input type="password" value={initPassword} onChange={(e) => setInitPassword(e.target.value)} />
              </label>
              <button type="submit">初始化管理员</button>
            </form>
          </section>
        )}

        {showLoginCard && (
          <section className="card">
            <h2>登录</h2>
            <form onSubmit={onLoginSubmit} className="form-grid">
              <label>
                用户名
                <input value={loginUsername} onChange={(e) => setLoginUsername(e.target.value)} />
              </label>
              <label>
                密码
                <input type="password" value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} />
              </label>
              <button type="submit">登录系统</button>
            </form>
            {error && <p className="notice error">{error}</p>}
            {message && <p className="notice ok">{message}</p>}
          </section>
        )}

        {adminInitialized === null && (
          <section className="card">
            <p>正在检查初始化状态...</p>
          </section>
        )}
      </div>
    );
  }

  return (
    <div className="mobile-shell">
      <div className="hero">
        <h1>飞书零花钱助手</h1>
        <p>{user.role === 'admin' ? '管理员' : '成员'}：{user.username}</p>
        <button
          className="ghost"
          onClick={() => {
            logout();
            setUser(null);
          }}
        >
          退出登录
        </button>
      </div>

      <section className="card section-nav-card">
        <div className="section-nav">
          <button className={activeTab === 'children' ? 'active' : ''} onClick={() => setActiveTab('children')}>小孩</button>
          {user.role === 'admin' && <button className={activeTab === 'robots' ? 'active' : ''} onClick={() => setActiveTab('robots')}>机器人设置</button>}
          <button className={activeTab === 'transactions' ? 'active' : ''} onClick={() => setActiveTab('transactions')}>流水</button>
          <button className={activeTab === 'models' ? 'active' : ''} onClick={() => setActiveTab('models')}>模型</button>
          <button className={activeTab === 'prompts' ? 'active' : ''} onClick={() => setActiveTab('prompts')}>模板</button>
          <button className={activeTab === 'summaries' ? 'active' : ''} onClick={() => setActiveTab('summaries')}>周报</button>
        </div>
      </section>

      {error && <p className="notice error">{error}</p>}
      {message && <p className="notice ok">{message}</p>}

      {activeTab === 'children' && (
      <section className="card">
        <h2>小孩与余额</h2>
        <div className="list">
          {children.map((child) => (
            <ChildItem
              key={child.id}
              child={child}
              canManage
              onAdjust={async (amount, reason) => {
                await adjustChild(child.id, { amount, reason });
                await reloadData(user);
                resetNotice('金额已更新并通知飞书');
              }}
              onSetDaily={async (amount) => {
                await setDailyAllowance(child.id, amount);
                await reloadData(user);
                resetNotice('每日额度设置成功');
              }}
              onSetReward={async (keyword, amount) => {
                await setRewardRule(child.id, keyword, amount);
                await reloadData(user);
                resetNotice('奖励规则设置成功');
              }}
            />
          ))}
        </div>
      </section>
      )}

      {activeTab === 'children' && user.role === 'admin' && (
        <section className="card">
          <h2>新增小孩</h2>
          <form onSubmit={onCreateChild} className="form-grid">
            <label>
              姓名
              <input value={newChildName} onChange={(e) => setNewChildName(e.target.value)} required />
            </label>
            <label>
              头像上传（可选）
              <input type="file" accept="image/*" onChange={onChildAvatarSelected} />
            </label>
            <p>未上传头像时，将自动使用默认头像。</p>
            {newChildAvatar && <img src={newChildAvatar} alt="头像预览" className="avatar" />}
            <label>
              每日额度(元)
              <input type="number" min={0} step="0.1" value={newChildDaily} onChange={(e) => setNewChildDaily(Number(e.target.value))} />
            </label>
            <button type="submit">创建小孩</button>
          </form>
        </section>
      )}

      {activeTab === 'robots' && user.role === 'admin' && (
        <>
          <section className="card">
            <h2>飞书通道配置</h2>
            <form onSubmit={onSaveFeishuBotConfig} className="form-grid">
              <label>
                飞书机器人实现方式
                <select value={feishuMode} onChange={(e) => setFeishuMode(e.target.value as 'app' | 'webhook')}>
                  <option value="app">自建应用事件订阅机器人（推荐）</option>
                  <option value="webhook">群 webhook 机器人（兼容）</option>
                </select>
              </label>

              <label>
                飞书 App ID（自建应用）
                <input value={feishuAppId} onChange={(e) => setFeishuAppId(e.target.value)} placeholder="cli_xxx" />
              </label>
              <label>
                飞书 App Secret（自建应用）
                <input type="password" value={feishuAppSecret} onChange={(e) => setFeishuAppSecret(e.target.value)} placeholder="应用凭证" />
              </label>
              <label>
                事件订阅 Verification Token
                <input value={feishuVerificationToken} onChange={(e) => setFeishuVerificationToken(e.target.value)} placeholder="可选，建议配置" />
              </label>
              <label>
                事件订阅 Signing Secret
                <input type="password" value={feishuSigningSecret} onChange={(e) => setFeishuSigningSecret(e.target.value)} placeholder="可选，建议配置" />
              </label>
              <label>
                默认发送 Chat ID
                <input value={feishuDefaultChatId} onChange={(e) => setFeishuDefaultChatId(e.target.value)} placeholder="oc_xxx（群或会话ID）" />
              </label>
              <label>
                当前最近活跃 Chat ID（只读）
                <input value={lastActiveChatId} readOnly />
              </label>
              <label>
                兼容 webhook 地址（可选）
                <input value={feishuWebhookUrl} onChange={(e) => setFeishuWebhookUrl(e.target.value)} placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." />
              </label>

              <button type="submit">保存飞书通道配置</button>
              <p>事件订阅回调地址：/api/feishu/events（兼容 /api/feishu/webhook）</p>
            </form>

            <form onSubmit={onSaveWeeklyNotify} className="form-grid inline-grid">
              <label>
                每周一通知小时
                <input type="number" min={0} max={23} value={notifyHour} onChange={(e) => setNotifyHour(Number(e.target.value))} />
              </label>
              <label>
                分钟
                <input type="number" min={0} max={59} value={notifyMinute} onChange={(e) => setNotifyMinute(Number(e.target.value))} />
              </label>
              <button type="submit">保存每周通知时间</button>
            </form>
          </section>

          <section className="card">
            <h2>机器人绑定规则</h2>
            <form onSubmit={onCreateRobot} className="form-grid">
              <label>
                机器人名称
                <input value={newRobotName} onChange={(e) => setNewRobotName(e.target.value)} required />
              </label>
              <label>
                绑定小孩
                <select
                  multiple
                  value={newRobotChildIds}
                  onChange={(e) => {
                    const options = Array.from(e.target.selectedOptions).map((item) => item.value);
                    setNewRobotChildIds(options);
                  }}
                >
                  {children.map((child) => (
                    <option key={child.id} value={child.id}>{child.name}</option>
                  ))}
                </select>
              </label>
              <label>
                可控制账号 OpenID（逗号或换行分隔）
                <textarea value={newRobotControllerIds} onChange={(e) => setNewRobotControllerIds(e.target.value)} required style={{ minHeight: '100px' }} />
              </label>
              <label>
                允许触发的 Chat ID（逗号或换行分隔，可留空）
                <textarea value={newRobotChatIds} onChange={(e) => setNewRobotChatIds(e.target.value)} style={{ minHeight: '80px' }} />
              </label>
              <label>
                启用状态
                <select value={newRobotEnabled ? 'enabled' : 'disabled'} onChange={(e) => setNewRobotEnabled(e.target.value === 'enabled')}>
                  <option value="enabled">启用</option>
                  <option value="disabled">停用</option>
                </select>
              </label>
              <button type="submit">创建机器人规则</button>
            </form>

            <div className="list">
              {robots.map((robot) => (
                <div className="sub-card" key={robot.id}>
                  <p><strong>{robot.name}</strong>（{robot.enabled ? '启用' : '停用'}）</p>
                  <p>小孩：{robot.childIds.map((id) => childMap.get(id)?.name ?? id).join('、') || '未绑定'}</p>
                  <p>控制账号：{robot.controllerOpenIds.join('、') || '未配置'}</p>
                  <p>允许群/会话：{robot.allowedChatIds.join('、') || '不限'}</p>
                  <div className="inline-grid">
                    <button
                      type="button"
                      onClick={async () => {
                        await updateRobot(robot.id, { enabled: !robot.enabled });
                        await reloadData(user);
                        resetNotice('机器人状态已更新');
                      }}
                    >
                      {robot.enabled ? '停用' : '启用'}
                    </button>
                    <button type="button" onClick={() => onQuickEditRobot(robot)}>
                      快速编辑
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        if (!confirm('确认删除该机器人规则？')) {
                          return;
                        }
                        await deleteRobot(robot.id);
                        await reloadData(user);
                        resetNotice('机器人规则已删除');
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {activeTab === 'transactions' && (
      <section className="card">
        <h2>记账流水</h2>
        <div className="list">
          {transactions.slice(0, 30).map((tx) => (
            <div className="sub-card" key={tx.id}>
              <p><strong>{childMap.get(tx.childId)?.name ?? tx.childId}</strong></p>
              <p className={tx.amount >= 0 ? 'positive' : 'negative'}>
                {tx.amount >= 0 ? '+' : ''}{tx.amount.toFixed(2)}元
              </p>
              <p>{tx.reason}</p>
              <p>{new Date(tx.createdAt).toLocaleString('zh-CN')}</p>
            </div>
          ))}
        </div>
      </section>
      )}

      {activeTab === 'models' && (
      <section className="card">
        <h2>模型配置</h2>
        {user.role === 'admin' && (
          <form onSubmit={async (e) => {
            e.preventDefault();
            try {
              await createModel({
                name: newModelName,
                provider: newModelProvider,
                apiUrl: newModelUrl,
                apiKey: newModelKey,
                modelId: newModelId,
                isBuiltIn: false,
                status: 'unconfigured'
              });
              setNewModelName('');
              setNewModelKey('');
              await reloadData(user);
              resetNotice('模型配置已添加');
            } catch (err) {
              setError((err as Error).message);
            }
          }} className="form-grid">
            <label>
              配置名称
              <input value={newModelName} onChange={(e) => setNewModelName(e.target.value)} required />
            </label>
            <label>
              服务商
              <select value={newModelProvider} onChange={(e) => {
                const provider = e.target.value as ModelConfig['provider'];
                setNewModelProvider(provider);
                setNewModelUrl(defaultApiUrlByProvider[provider]);
                setDiscoveredModelIds([]);
                setNewModelId('');
              }}>
                <option value="openai">OpenAI</option>
                <option value="deepseek">DeepSeek</option>
                <option value="google">Google</option>
                <option value="custom">自定义</option>
              </select>
            </label>
            <label>
              API地址
              <input value={newModelUrl} onChange={(e) => setNewModelUrl(e.target.value)} required />
            </label>
            <label>
              API Key
              <input type="password" value={newModelKey} onChange={(e) => setNewModelKey(e.target.value)} required />
            </label>
            <button type="button" onClick={onDiscoverProviderModels} disabled={discoveringModels}>
              {discoveringModels ? '获取中...' : '通过 APIKey+地址 获取模型列表'}
            </button>
            {discoveredModelIds.length > 0 && (
              <label>
                模型列表（自动发现）
                <select value={newModelId} onChange={(e) => setNewModelId(e.target.value)}>
                  {discoveredModelIds.map((modelId) => (
                    <option key={modelId} value={modelId}>{modelId}</option>
                  ))}
                </select>
              </label>
            )}
            <label>
              模型ID（可手填，可覆盖自动发现）
              <input value={newModelId} onChange={(e) => setNewModelId(e.target.value)} required />
            </label>
            <button type="submit">添加模型</button>
          </form>
        )}
        <div className="list">
          {models.map((model) => (
            <div className="sub-card" key={model.id}>
              <p><strong>{model.name}</strong> ({model.provider})</p>
              <p>状态: {model.status}</p>
              <p>模型ID: {model.modelId || '未设置'}</p>
              {user.role === 'admin' && (
                <button onClick={async () => {
                  if (confirm('确认删除此模型?')) {
                    await deleteModel(model.id);
                    await reloadData(user);
                    resetNotice('模型已删除');
                  }
                }}>删除</button>
              )}
            </div>
          ))}
        </div>
      </section>
      )}

      {activeTab === 'prompts' && (
      <section className="card">
        <h2>提示词模板</h2>
        {user.role === 'admin' && (
          <form onSubmit={async (e) => {
            e.preventDefault();
            try {
              await createPrompt({
                name: newPromptName,
                purpose: newPromptPurpose,
                content: newPromptContent,
                isBuiltIn: false,
                usageCount: 0
              });
              setNewPromptName('');
              setNewPromptContent('');
              await reloadData(user);
              resetNotice('提示词模板已添加');
            } catch (err) {
              setError((err as Error).message);
            }
          }} className="form-grid">
            <label>
              模板名称
              <input value={newPromptName} onChange={(e) => setNewPromptName(e.target.value)} required />
            </label>
            <label>
              用途
              <select value={newPromptPurpose} onChange={(e) => setNewPromptPurpose(e.target.value as any)}>
                <option value="vscode-chat">工作总结</option>
                <option value="daily">日报快报</option>
                <option value="weekly">周报总结</option>
                <option value="incident">事件报告</option>
                <option value="optimization">优化建议</option>
                <option value="pocket-money">零花钱助手</option>
                <option value="custom">自定义</option>
              </select>
            </label>
            <label>
              模板内容
              <textarea value={newPromptContent} onChange={(e) => setNewPromptContent(e.target.value)} required style={{ minHeight: '150px' }} />
            </label>
            <button type="submit">添加模板</button>
          </form>
        )}
        <div className="list">
          {prompts.map((prompt) => (
            <div className="sub-card" key={prompt.id}>
              <p><strong>{prompt.name}</strong> ({prompt.purpose})</p>
              <p>{prompt.content.substring(0, 100)}...</p>
              {user.role === 'admin' && (
                <button onClick={async () => {
                  if (confirm('确认删除此模板?')) {
                    await deletePrompt(prompt.id);
                    await reloadData(user);
                    resetNotice('模板已删除');
                  }
                }}>删除</button>
              )}
            </div>
          ))}
        </div>
      </section>
      )}

      {activeTab === 'summaries' && (
      <section className="card">
        <h2>每周统计</h2>
        <div className="list">
          {summaries.slice(0, 10).map((item) => (
            <div className="sub-card" key={item.id}>
              <p><strong>{childMap.get(item.childId)?.name ?? item.childId}</strong></p>
              <p>周期：{item.weekStartDate} ~ {item.weekEndDate}</p>
              <p>增加：{item.increasedAmount.toFixed(2)}元</p>
              <p>消费：{item.expenseAmount.toFixed(2)}元</p>
              <p>剩余：{item.remainingAmount.toFixed(2)}元</p>
              <p>最大消费：{item.maxExpenseReason} ({item.maxExpenseAmount.toFixed(2)}元)</p>
              <p>建议：{item.aiSuggestion}</p>
            </div>
          ))}
        </div>
      </section>
      )}
    </div>
  );
}

function ChildItem(props: {
  child: ChildProfile;
  canManage: boolean;
  onAdjust: (amount: number, reason: string) => Promise<void>;
  onSetDaily: (amount: number) => Promise<void>;
  onSetReward: (keyword: string, amount: number) => Promise<void>;
}) {
  const [amount, setAmount] = useState(0);
  const [reason, setReason] = useState('发放零花钱');
  const [daily, setDaily] = useState(props.child.dailyAllowance);
  const [rewardKeyword, setRewardKeyword] = useState('家务');
  const [rewardAmount, setRewardAmount] = useState(5);
  const avatarSrc = props.child.avatar || DEFAULT_AVATAR;

  return (
    <div className="sub-card">
      <p><strong>{props.child.name}</strong>（余额 {props.child.balance.toFixed(2)}元）</p>
      <img
        src={avatarSrc}
        alt={props.child.name}
        className="avatar"
        onError={(event) => {
          event.currentTarget.src = DEFAULT_AVATAR;
        }}
      />

      {props.canManage && (
        <>
          <div className="inline-grid">
            <label>
              增减金额(元)
              <input type="number" step="0.1" value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
            </label>
            <label>
              原因
              <input value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <button onClick={() => props.onAdjust(amount, reason)}>提交金额变动</button>
          </div>

          <div className="inline-grid">
            <label>
              每日额度(元)
              <input type="number" min={0} step="0.1" value={daily} onChange={(e) => setDaily(Number(e.target.value))} />
            </label>
            <button onClick={() => props.onSetDaily(daily)}>设置每日额度</button>
          </div>

          <div className="inline-grid">
            <label>
              奖励项目
              <input value={rewardKeyword} onChange={(e) => setRewardKeyword(e.target.value)} />
            </label>
            <label>
              奖励金额
              <input type="number" min={0.1} step="0.1" value={rewardAmount} onChange={(e) => setRewardAmount(Number(e.target.value))} />
            </label>
            <button onClick={() => props.onSetReward(rewardKeyword, rewardAmount)}>设置奖励规则</button>
          </div>
        </>
      )}

      {props.child.rewardRules.length > 0 && (
        <div className="tags">
          {props.child.rewardRules.map((rule) => (
            <span key={rule.id}>{rule.keyword} +{rule.amount}元</span>
          ))}
        </div>
      )}
    </div>
  );
}

export default App;
