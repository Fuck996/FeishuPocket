import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const DEFAULT_STORE = {
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
    filePath;
    data = structuredClone(DEFAULT_STORE);
    constructor(filePath) {
        this.filePath = filePath;
    }
    load() {
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
        const parsed = JSON.parse(raw);
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
    getSnapshot() {
        return this.data;
    }
    update(mutator) {
        mutator(this.data);
        this.save();
        return this.data;
    }
    // ===== Model Config CRUD =====
    addModel(model) {
        const now = new Date().toISOString();
        const newModel = {
            ...model,
            id: randomUUID(),
            createdAt: now,
            updatedAt: now
        };
        this.data.models.push(newModel);
        this.save();
        return newModel;
    }
    updateModel(id, updates) {
        const index = this.data.models.findIndex(m => m.id === id);
        if (index === -1)
            return null;
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
    getModel(id) {
        return this.data.models.find(m => m.id === id) ?? null;
    }
    getAllModels() {
        return this.data.models;
    }
    deleteModel(id) {
        const index = this.data.models.findIndex(m => m.id === id);
        if (index === -1)
            return false;
        this.data.models.splice(index, 1);
        this.save();
        return true;
    }
    // ===== Prompt Template CRUD =====
    addPrompt(prompt) {
        const now = new Date().toISOString();
        const newPrompt = {
            ...prompt,
            id: randomUUID(),
            createdAt: now,
            updatedAt: now
        };
        this.data.prompts.push(newPrompt);
        this.save();
        return newPrompt;
    }
    updatePrompt(id, updates) {
        const index = this.data.prompts.findIndex(p => p.id === id);
        if (index === -1)
            return null;
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
    getPrompt(id) {
        return this.data.prompts.find(p => p.id === id) ?? null;
    }
    getAllPrompts() {
        return this.data.prompts;
    }
    deletePrompt(id) {
        const index = this.data.prompts.findIndex(p => p.id === id);
        if (index === -1)
            return false;
        this.data.prompts.splice(index, 1);
        this.save();
        return true;
    }
    save() {
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    }
}
