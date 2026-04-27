import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { AppStore, ModelConfig, PromptTemplate } from './types.js';

const BUILT_IN_DEEPSEEK_MODEL_ID = 'built-in-deepseek';

const BUILT_IN_MCP_PROMPTS: Array<Omit<PromptTemplate, 'createdAt' | 'updatedAt'>> = [
  {
    id: 'vscode-chat-report',
    name: '工作总结',
    purpose: 'vscode-chat',
    content: `你是一个专业的工作总结专家。请根据本次任务内容生成一份清晰的工作总结。\n\n总结格式要求：\n1. ✅ 已完成的工作\n2. 🔧 关键改动\n3. 📝 后续说明\n\n要求：简洁、准确，便于团队快速同步。`,
    isBuiltIn: true,
    usageCount: 0
  },
  {
    id: 'daily-digest',
    name: '日报快报',
    purpose: 'daily',
    content: `你是一个日报编辑。请根据输入生成当日简报，包含重点事项、数据统计、明日计划。\n\n要求：结构清晰，字数控制在300字以内。`,
    isBuiltIn: true,
    usageCount: 0
  },
  {
    id: 'weekly-summary',
    name: '周报总结',
    purpose: 'weekly',
    content: `你是一个周报助手。请生成本周目标完成度、主要成就、挑战与下周计划。\n\n要求：强调可量化结果。`,
    isBuiltIn: true,
    usageCount: 0
  },
  {
    id: 'incident-report',
    name: '事件报告',
    purpose: 'incident',
    content: `你是事件管理专家。请按事件背景、影响范围、根因、处理过程、后续措施输出事件报告。`,
    isBuiltIn: true,
    usageCount: 0
  },
  {
    id: 'optimization-suggestion',
    name: '优化建议',
    purpose: 'optimization',
    content: `你是产品优化顾问。请基于输入给出可执行的优化方案、预期收益与实施计划。`,
    isBuiltIn: true,
    usageCount: 0
  }
];

const DEFAULT_STORE: AppStore = {
  users: [],
  children: [],
  transactions: [],
  weeklySummaries: [],
  models: [],
  prompts: [],
  config: {
    weeklyNotify: { hour: 20, minute: 0 },
    ignoreBotUserIds: [],
    defaultDailyAllowance: 10
  }
};

export class JsonStore {
  private readonly filePath: string;
  private data: AppStore = structuredClone(DEFAULT_STORE);

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  public load(): AppStore {
    const dirPath = path.dirname(this.filePath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    if (!fs.existsSync(this.filePath)) {
      this.data = structuredClone(DEFAULT_STORE);
      this.ensureBuiltInItems();
      this.save();
      return this.data;
    }

    const raw = fs.readFileSync(this.filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppStore>;
    this.data = {
      users: parsed.users ?? [],
      children: parsed.children ?? [],
      transactions: parsed.transactions ?? [],
      weeklySummaries: parsed.weeklySummaries ?? [],
      models: parsed.models ?? [],
      prompts: parsed.prompts ?? [],
      config: {
        weeklyNotify: parsed.config?.weeklyNotify ?? { hour: 20, minute: 0 },
        ignoreBotUserIds: parsed.config?.ignoreBotUserIds ?? [],
        defaultDailyAllowance: parsed.config?.defaultDailyAllowance ?? 10,
        lastDailyGrantDate: parsed.config?.lastDailyGrantDate
      }
    };

    // 增量补齐内置模型与提示词，避免破坏已有用户数据。
    const changed = this.ensureBuiltInItems();
    if (changed) {
      this.save();
    }
    return this.data;
  }

  private ensureBuiltInItems(): boolean {
    const modelChanged = this.ensureBuiltInDeepSeekModel();
    const promptChanged = this.ensureBuiltInMcpPrompts();
    return modelChanged || promptChanged;
  }

  private ensureBuiltInDeepSeekModel(): boolean {
    const now = new Date().toISOString();
    const existing = this.data.models.find((model) => model.id === BUILT_IN_DEEPSEEK_MODEL_ID);

    if (existing) {
      const before = JSON.stringify({
        name: existing.name,
        provider: existing.provider,
        apiUrl: existing.apiUrl,
        isBuiltIn: existing.isBuiltIn,
        status: existing.status
      });
      existing.name = 'DeepSeek';
      existing.provider = 'deepseek';
      existing.apiUrl = 'https://api.deepseek.com';
      existing.isBuiltIn = true;
      existing.updatedAt = now;
      if (!existing.status) {
        existing.status = 'unconfigured';
      }
      const after = JSON.stringify({
        name: existing.name,
        provider: existing.provider,
        apiUrl: existing.apiUrl,
        isBuiltIn: existing.isBuiltIn,
        status: existing.status
      });
      return before !== after;
    }

    this.data.models.unshift({
      id: BUILT_IN_DEEPSEEK_MODEL_ID,
      name: 'DeepSeek',
      provider: 'deepseek',
      apiUrl: 'https://api.deepseek.com',
      apiKey: undefined,
      modelId: undefined,
      isBuiltIn: true,
      status: 'unconfigured',
      createdAt: now,
      updatedAt: now
    });
    return true;
  }

  private ensureBuiltInMcpPrompts(): boolean {
    const now = new Date().toISOString();
    let changed = false;

    for (const builtInPrompt of BUILT_IN_MCP_PROMPTS) {
      const existing = this.data.prompts.find((item) => item.id === builtInPrompt.id);
      if (existing) {
        continue;
      }

      this.data.prompts.push({
        ...builtInPrompt,
        createdAt: now,
        updatedAt: now
      });
      changed = true;
    }

    return changed;
  }

  public getSnapshot(): AppStore {
    return this.data;
  }

  public update(mutator: (draft: AppStore) => void): AppStore {
    mutator(this.data);
    this.save();
    return this.data;
  }

  // ===== Model Config CRUD =====
  public addModel(model: Omit<ModelConfig, 'id' | 'createdAt' | 'updatedAt'>): ModelConfig {
    const now = new Date().toISOString();
    const newModel: ModelConfig = {
      ...model,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now
    };
    this.data.models.push(newModel);
    this.save();
    return newModel;
  }

  public updateModel(id: string, updates: Partial<ModelConfig>): ModelConfig | null {
    const index = this.data.models.findIndex(m => m.id === id);
    if (index === -1) return null;
    
    const model = this.data.models[index];
    const updated = {
      ...model,
      ...updates,
      id: model.id,
      createdAt: model.createdAt,
      updatedAt: new Date().toISOString()
    };
    this.data.models[index] = updated;
    this.save();
    return updated;
  }

  public getModel(id: string): ModelConfig | null {
    return this.data.models.find(m => m.id === id) ?? null;
  }

  public getAllModels(): ModelConfig[] {
    return this.data.models;
  }

  public deleteModel(id: string): boolean {
    const index = this.data.models.findIndex(m => m.id === id);
    if (index === -1) return false;
    
    this.data.models.splice(index, 1);
    this.save();
    return true;
  }

  // ===== Prompt Template CRUD =====
  public addPrompt(prompt: Omit<PromptTemplate, 'id' | 'createdAt' | 'updatedAt'>): PromptTemplate {
    const now = new Date().toISOString();
    const newPrompt: PromptTemplate = {
      ...prompt,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now
    };
    this.data.prompts.push(newPrompt);
    this.save();
    return newPrompt;
  }

  public updatePrompt(id: string, updates: Partial<PromptTemplate>): PromptTemplate | null {
    const index = this.data.prompts.findIndex(p => p.id === id);
    if (index === -1) return null;
    
    const prompt = this.data.prompts[index];
    const updated = {
      ...prompt,
      ...updates,
      id: prompt.id,
      createdAt: prompt.createdAt,
      updatedAt: new Date().toISOString()
    };
    this.data.prompts[index] = updated;
    this.save();
    return updated;
  }

  public getPrompt(id: string): PromptTemplate | null {
    return this.data.prompts.find(p => p.id === id) ?? null;
  }

  public getAllPrompts(): PromptTemplate[] {
    return this.data.prompts;
  }

  public deletePrompt(id: string): boolean {
    const index = this.data.prompts.findIndex(p => p.id === id);
    if (index === -1) return false;
    
    this.data.prompts.splice(index, 1);
    this.save();
    return true;
  }

  private save(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }
}
