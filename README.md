# 飞书零花钱助手

飞书零花钱助手是一个面向家庭场景的 Web 系统，核心交互在飞书群完成，后台提供移动端优先管理页面。

## 功能概览
1. 管理员初始化与账号体系（管理员/操作用户）
2. 小孩管理：姓名、头像、每日额度、余额
3. 操作用户绑定可控制小孩
4. 飞书群消息识别：
   - 调整每日零花钱额度
   - 设置额外奖励项目与金额
   - 扣除消费金额（支持负数扣除）
   - 设置每周统计通知时间（每周一）
5. 机器人主动通知：
   - 金额变动通知
   - 系统操作反馈通知
   - 每周统计通知 + 使用建议
6. 内置 MCP 服务器：支持四类后台操作工具

## 项目结构

backend/        后端 API 与业务逻辑
frontend/       移动端优先后台页面
mcp-server/     MCP 工具服务
docs/           需求、飞书流程、部署文档

## 本地开发

### 后端
cd backend
npm install
npm run dev

### 前端
cd frontend
npm install
npm run dev

### MCP 服务
cd mcp-server
npm install
# 需要管理员账号 token
set MCP_BACKEND_TOKEN=你的管理员JWT
set BACKEND_URL=http://localhost:3000
npm start

## 群晖容器部署
使用根目录 docker-compose.synology.yml：

docker compose -f docker-compose.synology.yml pull
docker compose -f docker-compose.synology.yml up -d

### GitHub 直接构建镜像
1. 在 GitHub Actions 执行工作流 Build & Push Images。
2. 填写 image_tag（例如 v0.1.2）并执行。
3. 群晖 .env 中设置：

IMAGE_NAMESPACE=你的GitHub用户名或组织名（小写）
IMAGE_TAG=v0.1.2

详细步骤见 docs/SYNOLOGY_DEPLOYMENT.md。

## 飞书侧操作
见 docs/FEISHU_OPERATION_GUIDE.md。
