# 部署指南 (Deployment Guide)

本项目已适配 Zeabur 等云平台部署。以下是部署说明。

## Zeabur 部署

### 1. 提交代码
将本项目代码提交到 GitHub 仓库。

### 2. 创建服务
在 Zeabur 控制台创建一个新的 Project，并选择 "Deploy New Service" -> "Git"，选择你的仓库。

### 3. 环境变量配置 (可选)
Zeabur 会自动识别 Node.js 项目并设置默认端口。
如果需要，可以在 Variables 中设置：
- `PORT`: 服务监听端口 (默认 3000)
- `HOST`: 监听地址 (默认 0.0.0.0)

### 4. 持久化存储 (重要)
为了防止重启或重新部署后数据丢失（漂流瓶数据、玩家数据等），**必须**配置持久化存储卷。

1. 在 Zeabur 该服务的 "Settings" -> "Volumes" (存储卷) 中添加一个挂载。
2. **Mount Path (挂载路径)**: 设置为 `/app/data` (或者你喜欢的其他路径)。
3. 在 "Variables" (环境变量) 中添加：
   - `DATA_DIR`: `/app/data` (必须与上面的挂载路径一致)

这样，数据库文件 `drift.sqlite` 将被保存到持久化卷中，不会因部署而丢失。

## 本地运行

```bash
npm install
npm start
```

数据将默认保存在项目根目录下的 `drift.sqlite`。
