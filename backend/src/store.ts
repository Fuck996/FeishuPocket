import fs from 'node:fs';
import path from 'node:path';

import { AppStore } from './types.js';

const DEFAULT_STORE: AppStore = {
  users: [],
  children: [],
  transactions: [],
  weeklySummaries: [],
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

  private save(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }
}
