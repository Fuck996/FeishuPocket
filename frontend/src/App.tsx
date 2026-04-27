import { FormEvent, useEffect, useMemo, useState } from 'react';

import {
  adjustChild,
  bindFeishu,
  createChild,
  createOperator,
  getChildren,
  getOperators,
  getTransactions,
  getWeeklySummaries,
  initAdmin,
  login,
  logout,
  me,
  setDailyAllowance,
  setRewardRule,
  setWeeklyNotify,
  updateOperator
} from './api';
import { ChildProfile, OperatorUser, UserInfo, WeeklySummary } from './types';

function App() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [children, setChildren] = useState<ChildProfile[]>([]);
  const [operators, setOperators] = useState<OperatorUser[]>([]);
  const [transactions, setTransactions] = useState<Array<{ id: string; childId: string; amount: number; reason: string; createdAt: string }>>([]);
  const [summaries, setSummaries] = useState<WeeklySummary[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const [loginUsername, setLoginUsername] = useState('admin');
  const [loginPassword, setLoginPassword] = useState('admin');
  const [initUsername, setInitUsername] = useState('admin');
  const [initPassword, setInitPassword] = useState('admin');

  const [newChildName, setNewChildName] = useState('');
  const [newChildAvatar, setNewChildAvatar] = useState('');
  const [newChildDaily, setNewChildDaily] = useState(10);

  const [newOperatorName, setNewOperatorName] = useState('');
  const [newOperatorPassword, setNewOperatorPassword] = useState('123456');
  const [newOperatorChildIds, setNewOperatorChildIds] = useState<string[]>([]);

  const [bindFeishuId, setBindFeishuId] = useState('');
  const [notifyHour, setNotifyHour] = useState(20);
  const [notifyMinute, setNotifyMinute] = useState(0);

  const childMap = useMemo(() => {
    return new Map(children.map((item) => [item.id, item]));
  }, [children]);

  async function reloadData(currentUser: UserInfo): Promise<void> {
    const [childList, txList, weeklyList] = await Promise.all([getChildren(), getTransactions(), getWeeklySummaries()]);
    setChildren(childList);
    setTransactions(txList);
    setSummaries(weeklyList);
    if (currentUser.role === 'admin') {
      const operatorList = await getOperators();
      setOperators(operatorList);
    } else {
      setOperators([]);
    }
  }

  useEffect(() => {
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
      const info = await login(loginUsername, loginPassword);
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
      await initAdmin(initUsername, initPassword);
      resetNotice('管理员初始化成功，请直接登录');
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

  async function onCreateOperator(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      await createOperator({
        username: newOperatorName,
        password: newOperatorPassword,
        childIds: newOperatorChildIds
      });
      setNewOperatorName('');
      setNewOperatorPassword('123456');
      setNewOperatorChildIds([]);
      await reloadData(user as UserInfo);
      resetNotice('操作用户创建成功');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onBindFeishu(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      await bindFeishu(bindFeishuId);
      if (user) {
        const info = await me();
        setUser(info);
      }
      resetNotice('飞书账号绑定成功');
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

  if (!user) {
    return (
      <div className="mobile-shell">
        <div className="hero">
          <h1>飞书零花钱助手</h1>
          <p>群聊记账 + 管理后台 + MCP 自动操作</p>
        </div>

        <section className="card">
          <h2>管理员初始化</h2>
          <form onSubmit={onInitAdminSubmit} className="form-grid">
            <label>
              用户名
              <input value={initUsername} onChange={(e) => setInitUsername(e.target.value)} />
            </label>
            <label>
              密码
              <input type="password" value={initPassword} onChange={(e) => setInitPassword(e.target.value)} />
            </label>
            <button type="submit">初始化管理员</button>
          </form>
        </section>

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
      </div>
    );
  }

  return (
    <div className="mobile-shell">
      <div className="hero">
        <h1>飞书零花钱助手</h1>
        <p>{user.role === 'admin' ? '管理员' : '操作员'}：{user.username}</p>
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

      {error && <p className="notice error">{error}</p>}
      {message && <p className="notice ok">{message}</p>}

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

      {user.role === 'admin' && (
        <section className="card">
          <h2>新增小孩</h2>
          <form onSubmit={onCreateChild} className="form-grid">
            <label>
              姓名
              <input value={newChildName} onChange={(e) => setNewChildName(e.target.value)} required />
            </label>
            <label>
              头像URL
              <input value={newChildAvatar} onChange={(e) => setNewChildAvatar(e.target.value)} />
            </label>
            <label>
              每日额度(元)
              <input type="number" min={0} step="0.1" value={newChildDaily} onChange={(e) => setNewChildDaily(Number(e.target.value))} />
            </label>
            <button type="submit">创建小孩</button>
          </form>
        </section>
      )}

      {user.role === 'admin' && (
        <section className="card">
          <h2>操作用户管理</h2>
          <form onSubmit={onCreateOperator} className="form-grid">
            <label>
              用户名
              <input value={newOperatorName} onChange={(e) => setNewOperatorName(e.target.value)} required />
            </label>
            <label>
              初始密码
              <input value={newOperatorPassword} onChange={(e) => setNewOperatorPassword(e.target.value)} required />
            </label>
            <label>
              可控制小孩
              <select
                multiple
                value={newOperatorChildIds}
                onChange={(e) => {
                  const options = Array.from(e.target.selectedOptions).map((item) => item.value);
                  setNewOperatorChildIds(options);
                }}
              >
                {children.map((child) => (
                  <option key={child.id} value={child.id}>{child.name}</option>
                ))}
              </select>
            </label>
            <button type="submit">新增操作用户</button>
          </form>

          <div className="list">
            {operators.map((operator) => (
              <div className="sub-card" key={operator.id}>
                <p><strong>{operator.username}</strong></p>
                <p>绑定飞书：{operator.boundFeishuUserId || '未绑定'}</p>
                <p>控制对象：{operator.childIds.map((id) => childMap.get(id)?.name ?? id).join('、') || '未分配'}</p>
                <button
                  onClick={async () => {
                    await updateOperator(operator.id, {
                      childIds: operator.childIds,
                      boundFeishuUserId: prompt('请输入飞书OpenID', operator.boundFeishuUserId ?? '') ?? ''
                    });
                    await reloadData(user);
                    resetNotice('操作用户更新成功');
                  }}
                >
                  快速绑定飞书ID
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <h2>系统配置</h2>
        <form onSubmit={onBindFeishu} className="form-grid">
          <label>
            当前账号绑定飞书OpenID
            <input value={bindFeishuId} onChange={(e) => setBindFeishuId(e.target.value)} placeholder={user.boundFeishuUserId || '例如 ou_xxx'} />
          </label>
          <button type="submit">绑定飞书账号</button>
        </form>

        {user.role === 'admin' && (
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
        )}
      </section>

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

  return (
    <div className="sub-card">
      <p><strong>{props.child.name}</strong>（余额 {props.child.balance.toFixed(2)}元）</p>
      {props.child.avatar ? <img src={props.child.avatar} alt={props.child.name} className="avatar" /> : null}

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
