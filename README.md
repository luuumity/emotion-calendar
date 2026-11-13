# 情绪日历 · Emotion Capsule

一个用来衡量「两个人到底能不能磨合」的双人情绪记录应用。

每天从红到绿挑一个颜色，拖进扭蛋机，变成一颗有物理碰撞的扭蛋；月视图里每个日期就是那天的颜色。两个人各自记录，只有拿到对方生成的授权凭证，才能以只读方式查看对方的颜色或理由。

## 功能

- **月视图**：日期色块、我的/对方双色对照、本月情绪曲线、同感指数与趋势。
- **日视图（扭蛋机）**：Matter.js 真实物理，拖动色块投进玻璃罩，扭蛋下落并与已有扭蛋碰撞；点击任意扭蛋可查看/编辑当天的理由。
- **隐私与授权**：默认完全隔离。生成凭证时可选择「仅颜色」或「颜色 + 理由」；对方兑换后只读访问，随时可撤销。
- **账号体系**：用户名 + 密码，HttpOnly Cookie 会话，数据按用户隔离。

同感指数 = `100 − 当天两人感受分数的平均差值`，用于粗略观察磨合程度，不构成任何关系判断。

## 技术栈

- 前端：React 18 + TypeScript + Vite + React Router + Matter.js
- 后端：Node.js + Express + better-sqlite3
- 数据：SQLite（单文件，默认在 `server/data/emotion.db`）
- 部署：单进程同时提供 API 与前端静态文件，Docker / 直接 Node 均可

## 目录

```
client/          前端（Vite）
  src/pages/     月视图 / 日视图 / 授权管理 / 登录
  src/components/GachaMachine.tsx 扭蛋机物理画布
server/          后端（Express + SQLite）
  src/routes/    auth / records / access
Dockerfile
docker-compose.yml
```

## 本地开发

要求 Node.js 22+。

```bash
npm install
npm --prefix server install
npm --prefix client install
npm run dev
```

- 前端：http://localhost:5173（`/api` 自动代理到 3001）
- 后端：http://localhost:3001
- 构建前端：`npm run build`
- 生产启动：`npm start`（先 build，后端会同时托管 `client/dist`）

## 生产部署

> 针对 `cinnamon.xin` 服务器的完整操作手册见 [DEPLOY.md](./DEPLOY.md)（含 Node 安装、systemd、Nginx、HTTPS、备份与更新流程）。

服务器上只需要：**Node 22+ 或 Docker**、**已解析到服务器的域名**、**80/443 端口**。HTTPS 证书可以用 Let's Encrypt 免费签发。

### 方式一：Docker（推荐）

```bash
# 在项目根目录
docker compose up -d --build
docker compose logs -f app
```

应用只监听本机 `127.0.0.1:3001`，对外由 Nginx 反向代理，数据持久化在 `./data`。

建议前面加一层 Nginx 反向代理并启用 HTTPS：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

然后签发证书（以 certbot 为例）：

```bash
sudo certbot --nginx -d your-domain.com
```

证书生效后，把 `docker-compose.yml` 里的 `COOKIE_SECURE` 改成 `"1"`，再执行：

```bash
docker compose up -d
```

### 方式二：直接跑 Node（无 Docker）

```bash
npm --prefix server ci --omit=dev
npm --prefix client ci
npm run build
```

用 pm2 或 systemd 守护：

```bash
PORT=3001 DB_PATH=/srv/emotion-calendar/data/emotion.db pm2 start server/src/index.js --name emotion-calendar
```

同样建议用 Nginx 反向代理 + HTTPS。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 监听地址；生产环境建议设为 `127.0.0.1` 只允许本机 Nginx 访问 |
| `PORT` | `3001` | 服务端口 |
| `DB_PATH` | `server/data/emotion.db` | SQLite 文件路径 |
| `JWT_SECRET` | 自动生成 | 会话签名密钥；不设置则生成并保存在 data 目录 |
| `JWT_SECRET_FILE` | `server/data/jwt-secret.txt` | 自动生成密钥的保存位置 |
| `COOKIE_SECURE` | `0` | 设为 `1` 时登录 Cookie 仅通过 HTTPS 发送 |

### 数据备份

所有数据都在 SQLite 文件里，直接备份 `data/` 目录即可：

```bash
docker compose exec app sh -c 'cp /app/server/data/emotion.db /app/server/data/backup-$(date +%F).db'
```

## 使用流程

1. 两个人各自注册账号。
2. 想共享的一方进入「授权管理」，选择范围，生成凭证并发给对方。
3. 对方登录后在「授权管理」输入凭证兑换。
4. 双方即可在月视图切换对照，查看同感指数；日视图可切换到对方视角只读查看。
5. 任何一方都能随时撤销授权或移除查看权限。

## 安全说明

- 密码使用 bcrypt 哈希存储。
- 会话使用 HttpOnly + SameSite=Lax 的 JWT Cookie。
- 所有记录接口强制校验当前用户；查看他人数据必须存在有效授权且未被撤销。
- 未授权的数据不会出现在任何接口返回中；「仅颜色」授权下理由字段不会下发。

如需对外公开注册，建议在 Nginx 层加请求频率限制，或先关闭注册入口自行邀请使用。
