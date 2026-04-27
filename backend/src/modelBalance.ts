import { ModelConfig } from './types.js';
import { store } from './server.js';

const LOW_BALANCE_THRESHOLD = 1; // 余额不足1元时通知
const LOW_BALANCE_ALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12小时内不重复通知

interface DeepSeekBalanceResponse {
  is_available?: boolean;
  balance_log_list?: Array<{ total_balance?: number }>;
  balance_infos?: Array<{ total_balance?: number }>;
}

/**
 * 从DeepSeek API响应中提取余额
 */
export function extractDeepSeekBalance(data: DeepSeekBalanceResponse): number | null {
  if (data.balance_log_list && data.balance_log_list.length > 0) {
    return data.balance_log_list[0].total_balance ?? null;
  }

  if (data.balance_infos && data.balance_infos.length > 0) {
    return data.balance_infos[0].total_balance ?? null;
  }

  return null;
}

/**
 * 获取模型余额
 * 目前支持 DeepSeek
 */
export async function fetchModelBalance(model: ModelConfig): Promise<number | null> {
  if (model.provider !== 'deepseek' || !model.apiKey) {
    return null;
  }

  try {
    const response = await fetch('https://api.deepseek.com/user/balance', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${model.apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as DeepSeekBalanceResponse;
    return extractDeepSeekBalance(data);
  } catch (error) {
    console.error(`[modelBalance] Failed to fetch balance for model ${model.name}:`, error);
    return null;
  }
}

/**
 * 检查最近是否有低余额告警
 */
function hasRecentLowBalanceAlert(modelId: string): boolean {
  const now = new Date().getTime();
  // 这里简化实现，实际项目中应该在transaction等处记录告警历史
  // 目前先返回false，允许通知
  return false;
}

/**
 * 如果余额不足则发送飞书通知
 */
export async function notifyLowBalanceIfNeeded(model: ModelConfig, balance: number | null): Promise<void> {
  if (balance === null || balance > LOW_BALANCE_THRESHOLD) {
    return;
  }

  // 检查冷却期
  if (hasRecentLowBalanceAlert(model.id)) {
    console.info(`[modelBalance] Low balance alert for model ${model.name} is in cooldown, skipping notification`);
    return;
  }

  // 构建通知内容
  const title = `⚠️ 模型 ${model.name} 余额预警`;
  const summary = `检测到模型 ${model.name} 当前余额为 ¥${balance.toFixed(2)}，已低于预警阈值 ¥${LOW_BALANCE_THRESHOLD.toFixed(2)}。\n请及时充值，避免 AI 服务中断。`;

  console.warn(`[modelBalance] Model ${model.name} has low balance: ¥${balance.toFixed(2)}`);

  // TODO: 发送飞书通知
  // 这里需要调用飞书服务发送卡片消息
  // await feishuService.sendNotification({...})
}

/**
 * 检查所有模型的余额
 */
export async function checkAllModelBalances(): Promise<void> {
  const models = store.getAllModels();
  
  for (const model of models) {
    if (model.provider !== 'deepseek' || !model.apiKey) {
      continue;
    }

    try {
      const balance = await fetchModelBalance(model);
      await notifyLowBalanceIfNeeded(model, balance);

      // 更新模型测试时间
      if (balance !== null) {
        store.updateModel(model.id, {
          status: 'connected',
          lastTestedAt: new Date().toISOString()
        });
      }
    } catch (error) {
      console.error(`[modelBalance] Error checking balance for model ${model.name}:`, error);
      store.updateModel(model.id, { status: 'disconnected' });
    }
  }
}
