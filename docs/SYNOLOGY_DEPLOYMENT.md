# 群晖容器部署指南
**版本：** v0.1.1 | **更新时间：** 2026-04-27 | **内容：** 飞书零花钱助手在群晖 Container Manager 的 GHCR 镜像拉取部署流程

## 1. 前置条件
1. 群晖 DSM 7.2+
2. 已安装 Container Manager
3. 已准备本项目代码目录（包含 docker-compose.synology.yml）

## 2. 环境变量准备
在项目根目录创建 .env 文件：

APP_PORT=45173
JWT_SECRET=请替换为高强度随机字符串
IMAGE_REGISTRY=ghcr.io
IMAGE_NAMESPACE=你的github用户名或组织（小写）
IMAGE_TAG=latest
FEISHU_WEBHOOK_URL=飞书机器人Webhook地址
OPENAI_API_KEY=可选
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
TZ=Asia/Shanghai

## 3. GitHub 先构建镜像
1. 打开仓库 Actions。
2. 运行 Build & Push Images 工作流。
3. image_tag 建议填写版本号，例如 v0.1.2。

## 4. 群晖拉取并部署
在群晖 SSH 中执行：

mkdir -p /volume1/docker/feishu-pocket
cd /volume1/docker/feishu-pocket
# 上传 compose 和 .env 文件后执行
docker compose -f docker-compose.synology.yml pull
docker compose -f docker-compose.synology.yml up -d

## 5. GHCR 私有仓库登录（如仓库私有）
docker login ghcr.io -u 你的GitHub用户名 -p 你的PAT

## 6. 验证启动
1. 浏览器访问：http://群晖IP:APP_PORT
2. 首次进入先初始化管理员。
3. 登录后创建小孩和操作用户。

## 7. 升级流程
1. 在 GitHub Actions 重新构建新标签镜像。
2. 修改 .env 的 IMAGE_TAG。
3. 执行：
docker compose -f docker-compose.synology.yml pull
docker compose -f docker-compose.synology.yml up -d

## 8. 数据持久化
系统数据存储在 Docker Volume feishu-pocket-data 中，不会因容器重建丢失。

## 9. 常见问题
1. 页面可访问但接口失败
   - 检查 backend 容器是否运行
2. 飞书无通知
   - 检查 FEISHU_WEBHOOK_URL 是否正确
   - 检查飞书事件订阅回调是否配置到 /api/feishu/webhook
3. 周报不触发
   - 检查系统配置中的周报时间
   - 检查容器时区 TZ 是否为 Asia/Shanghai