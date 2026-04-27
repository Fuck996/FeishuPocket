import cron, { ScheduledTask } from 'node-cron';

export interface SchedulerHandlers {
  runDailyGrant: () => Promise<void>;
  runWeeklySummary: () => Promise<void>;
}

export class SchedulerService {
  private readonly handlers: SchedulerHandlers;
  private dailyTask: ScheduledTask;
  private weeklyTask: ScheduledTask;

  constructor(handlers: SchedulerHandlers, weeklyHour: number, weeklyMinute: number) {
    this.handlers = handlers;

    this.dailyTask = cron.schedule('0 8 * * *', async () => {
      await this.handlers.runDailyGrant();
    });

    this.weeklyTask = this.createWeeklyTask(weeklyHour, weeklyMinute);
  }

  public updateWeeklySchedule(hour: number, minute: number): void {
    this.weeklyTask.stop();
    this.weeklyTask = this.createWeeklyTask(hour, minute);
  }

  private createWeeklyTask(hour: number, minute: number): ScheduledTask {
    const expression = `${minute} ${hour} * * 1`;
    return cron.schedule(expression, async () => {
      await this.handlers.runWeeklySummary();
    });
  }
}
