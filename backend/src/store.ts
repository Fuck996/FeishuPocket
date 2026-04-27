import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { AppStore, ModelConfig, PromptTemplate } from './types.js';

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
    return this.data;
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
