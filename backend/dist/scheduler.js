import cron from 'node-cron';
export class SchedulerService {
    handlers;
    dailyTask;
    weeklyTask;
    modelBalanceTask;
    constructor(handlers, weeklyHour, weeklyMinute) {
        this.handlers = handlers;
        this.dailyTask = cron.schedule('0 8 * * *', async () => {
            await this.handlers.runDailyGrant();
        });
        this.weeklyTask = this.createWeeklyTask(weeklyHour, weeklyMinute);
        // 每小时检查一次模型余额
        if (this.handlers.checkModelBalances) {
            this.modelBalanceTask = cron.schedule('0 * * * *', async () => {
                await this.handlers.checkModelBalances();
            });
        }
    }
    updateWeeklySchedule(hour, minute) {
        this.weeklyTask.stop();
        this.weeklyTask = this.createWeeklyTask(hour, minute);
    }
    createWeeklyTask(hour, minute) {
        const expression = `${minute} ${hour} * * 1`;
        return cron.schedule(expression, async () => {
            await this.handlers.runWeeklySummary();
        });
    }
}
