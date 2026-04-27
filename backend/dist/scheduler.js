import cron from 'node-cron';
export class SchedulerService {
    handlers;
    dailyTask;
    weeklyTask;
    modelBalanceTask;
    constructor(handlers, weeklyHour, weeklyMinute) {
        this.handlers = handlers;
        // 每分钟检查一次，按每个孩子各自配置的发放时间发放零花钱
        this.dailyTask = cron.schedule('* * * * *', async () => {
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
