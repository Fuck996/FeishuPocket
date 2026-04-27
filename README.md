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

## 容器部署（单容器）

### 快速开始

使用根目录 docker-compose.yml：

```bash
# 1. 复制环境变量示例
cp .env.example .env

# 2. 启动容器（首次，完全自动初始化）

# 3. 启动容器（首次）
docker compose up -d

# 3. 初始化管理员（仅首次，容器自动生成 JWT 密钥）
curl -X POST http://localhost:45174/api/init-admin \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your-secure-password"}'

# 4. 登录并在 UI 中配置：
#    - 飞书群机器人 webhook（在管理后台）
#    - AI 模型配置：DeepSeek API key（在模型管理页面）
#    - 其他小孩、奖励规则等
```

### 配置项说明

| 配置项 | 位置 | 说明 |
|--------|------|------|
| 飞书 Webhook | 系统配置 API | 管理员在 UI 中设置 |
| 模型 API Key | 模型管理页面 | 支持 DeepSeek、OpenAI、Google |
| 小孩绑定 | 系统 UI | 与飞书用户关联 |

### 后续更新

数据和 JWT 密钥已持久化到 `./data` 目录，重新部署时数据不丢失：

```bash
docker compose pull
docker compose up -d
```

### 数据持久化结构

```
./data/
  store.json        # 所有业务数据（小孩、消费、配置等）
  .jwt-secret       # JWT 密钥（首次启动自动生成）
./config/
  # 预留目录，可放置自定义配置文件
```

### GitHub 直接构建镜像

1. 在 GitHub Actions 执行工作流 Build & Push Images。
2. 填写 image_tag（例如 v0.2.1）并执行。
3. 更新 .env 中的 IMAGE_TAG=v0.2.1（或对应版本）。

详细步骤见 docs/SYNOLOGY_DEPLOYMENT.md。

## 飞书侧操作
见 docs/FEISHU_OPERATION_GUIDE.md。
