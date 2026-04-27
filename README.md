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
7. 管理后台分区导航：按“小孩/操作员/系统配置/流水/模型/模板/周报”切换

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

### 模型与模板默认行为

1. 系统会自动生成默认推荐模型 `DeepSeek`（可修改）。
2. DeepSeek 默认 API 地址为 `https://api.deepseek.com`。
3. 模型配置通过“API Key + API 地址”可直接获取模型列表，再选择模型 ID（也支持手填修改）。
4. 系统会自动生成默认 MCP 模板（工作总结/日报快报/周报总结/事件报告/优化建议），并保留可编辑能力。

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
2. 触发构建后确认镜像已推送到 ghcr.io。
3. 本项目 `docker-compose.yml` 已固定镜像地址，常规部署无需再手动改镜像参数。

详细步骤见 docs/SYNOLOGY_DEPLOYMENT.md。

## 飞书侧操作
### 1. 创建并配置飞书群机器人
1. 推荐使用“飞书自建应用机器人（事件订阅）”，不要依赖群 webhook 机器人来接收消息。
2. 在飞书开放平台创建自建应用，开启机器人能力与消息事件订阅。
3. 配置事件订阅回调地址：
  - 回调 URL：`http://你的服务地址/api/feishu/events`
  - 兼容 URL：`http://你的服务地址/api/feishu/webhook`
4. 在后台“系统配置”中保存：`App ID`、`App Secret`、`Verification Token`、`Signing Secret`、默认 `Chat ID`。
5. 若仍有历史 webhook 场景，可在系统配置中切换到 webhook 兼容模式。

### 2. 初始化与账号绑定
1. 首次访问时先初始化管理员（仅一次，可自定义管理员用户名）。
2. 初始化成功后再登录系统。
3. 管理员登录后创建小孩、创建操作用户并分配可控制小孩。
4. 小孩头像采用“文件上传”（可选），未上传时系统显示默认头像。
5. 每个用户在后台绑定自己的飞书 OpenID。
6. 管理员可在“操作用户管理”中维护操作员的飞书 OpenID。
7. 控制账号与小孩绑定后，控制账号在“单聊”或“群聊”发言都可触发机器人操作。

### 3. 群聊支持语句
1. 调整每日额度：`设置小明每日零花钱 12 元`
2. 设置额外奖励项目：`设置小明奖励项目家务 5 元`
3. 扣除消费：`扣除小明 8 元 买零食`
4. 设置每周通知时间：`设置每周统计通知 20:30`
5. 完成奖励触发：`小明完成家务`

### 4. 主动通知类型
1. 金额变动通知：金额、原因、来源（管理员/操作员/机器人/定时任务）
2. 系统操作反馈：每日额度、奖励规则、周报时间设置结果
3. 每周统计通知（周一）：总增加、总消费、剩余、最大消费项目、建议

### 5. 消息过滤策略
1. 自动忽略 `sender_type = bot` 的消息。
2. 自动忽略系统配置 `ignoreBotUserIds` 中的发送者。
3. 自动忽略未绑定飞书账号的发送者（即未绑定控制账号）。
