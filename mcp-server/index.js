import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const backendBaseUrl = process.env.BACKEND_URL || 'http://localhost:3000';
const backendToken = process.env.MCP_BACKEND_TOKEN || '';

async function callBackend(path, method, body) {
  const response = await fetch(`${backendBaseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${backendToken}`
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await response.json();
  if (!response.ok || data.success === false) {
    throw new Error(data.error || '调用后端失败');
  }
  return data;
}

const server = new Server(
  {
    name: 'feishu-pocket-mcp',
    version: '0.1.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'adjust_daily_allowance',
      description: '调整某个小孩的每日零花钱额度（元）',
      inputSchema: {
        type: 'object',
        properties: {
          childId: { type: 'string' },
          amount: { type: 'number', minimum: 0 }
        },
        required: ['childId', 'amount']
      }
    },
    {
      name: 'set_reward_item',
      description: '设置额外奖励项目与金额',
      inputSchema: {
        type: 'object',
        properties: {
          childId: { type: 'string' },
          keyword: { type: 'string' },
          amount: { type: 'number', minimum: 0.01 }
        },
        required: ['childId', 'keyword', 'amount']
      }
    },
    {
      name: 'deduct_expense',
      description: '扣除零花钱，可传负数表示反向增加',
      inputSchema: {
        type: 'object',
        properties: {
          childId: { type: 'string' },
          amount: { type: 'number' },
          reason: { type: 'string' }
        },
        required: ['childId', 'amount']
      }
    },
    {
      name: 'set_weekly_notify_time',
      description: '设置每周一统计通知时间，精确到分',
      inputSchema: {
        type: 'object',
        properties: {
          hour: { type: 'integer', minimum: 0, maximum: 23 },
          minute: { type: 'integer', minimum: 0, maximum: 59 }
        },
        required: ['hour', 'minute']
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments || {};

  if (!backendToken) {
    return {
      content: [
        {
          type: 'text',
          text: 'MCP_BACKEND_TOKEN 未配置，无法调用后端接口。'
        }
      ],
      isError: true
    };
  }

  try {
    switch (request.params.name) {
      case 'adjust_daily_allowance': {
        await callBackend('/api/config/daily-allowance', 'PUT', {
          childId: args.childId,
          amount: args.amount
        });
        return { content: [{ type: 'text', text: '每日零花钱额度调整成功。' }] };
      }
      case 'set_reward_item': {
        await callBackend('/api/config/reward-rule', 'PUT', {
          childId: args.childId,
          keyword: args.keyword,
          amount: args.amount
        });
        return { content: [{ type: 'text', text: '额外奖励项目设置成功。' }] };
      }
      case 'deduct_expense': {
        await callBackend(`/api/children/${args.childId}/adjust`, 'POST', {
          amount: -Number(args.amount),
          reason: args.reason || '消费',
          type: 'expense'
        });
        return { content: [{ type: 'text', text: '消费扣减成功。' }] };
      }
      case 'set_weekly_notify_time': {
        await callBackend('/api/config/weekly-notify', 'PUT', {
          hour: args.hour,
          minute: args.minute
        });
        return { content: [{ type: 'text', text: '每周通知时间更新成功。' }] };
      }
      default:
        return {
          content: [{ type: 'text', text: `未知工具: ${request.params.name}` }],
          isError: true
        };
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `执行失败: ${error.message}` }],
      isError: true
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
