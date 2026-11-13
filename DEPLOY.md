# 部署手册 · emotion.cinnamon.xin

面向服务器 `43.103.44.162`（Ubuntu 22.04，root）的从零部署步骤。

应用是**单进程 Node.js 服务**：同一个进程提供 `/api` 接口和前端静态文件，数据存在一个 SQLite 文件里。Nginx 只做反向代理和 HTTPS。

## 0. 与现有服务隔离（重要）

这台服务器上已经运行着 `homecare.cinnamon.xin`（`/opt/homecare`、`homecare-api.service`）。本手册只新建下面这些资源，**不修改、不重启** homecare 的任何文件或服务：

| 项目 | 本应用使用 | homecare 使用（不要动） |
| --- | --- | --- |
| 代码目录 | `/opt/emotion-calendar` | `/opt/homecare` |
| 端口 | `127.0.0.1:3100` | 保持原样 |
| systemd 服务 | `emotion-calendar.service` | `homecare-api.service` |
| Nginx 配置 | `/etc/nginx/sites-available/emotion-calendar.conf` | 现有 homecare 配置 |
| 域名 | `emotion.cinnamon.xin` | `homecare.cinnamon.xin` |
| 数据 | `/opt/emotion-calendar/data/emotion.db` | `/opt/homecare/data/eldercare.db` |

执行前先确认环境：

```bash
node -v || true
npm -v || true
nginx -v
systemctl status homecare-api --no-pager | head -5
ss -ltnp | grep -E ':(80|443|3100)\b' || true
df -h /
```

`3100` 端口必须是空的。如果被占用，换一个端口，并同步修改第 6 步的 `PORT` 和第 8 步 Nginx 的 `proxy_pass`。

## 1. 域名解析

已添加：`emotion.cinnamon.xin` → `43.103.44.162`（A 记录）。验证：

```bash
dig +short emotion.cinnamon.xin
# 期望输出：43.103.44.162
```

如果服务器上没装 `dig`，用 `getent hosts emotion.cinnamon.xin` 也可以。

## 2. 安装 Node.js 22

Ubuntu 22.04 自带的 Node 版本太旧，用 NodeSource 安装：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs build-essential python3
node -v   # 期望 v22.x
npm -v
```

`build-essential` 和 `python3` 用于 `better-sqlite3` 在缺少预编译包时回退到本地编译。

如果服务器访问 npm 官方源较慢，可以只给本机设置镜像（不影响系统其他项目）：

```bash
npm config set registry https://registry.npmmirror.com
```

## 3. 拉取代码

仓库是公开的，直接 HTTPS 克隆，不需要配置部署密钥：

```bash
mkdir -p /opt
cd /opt
git clone https://github.com/luuumity/emotion-calendar.git
```

如果服务器访问 GitHub 较慢或超时，可以在本地下载 ZIP 后上传到服务器解压，目录名保持 `/opt/emotion-calendar` 即可。

> 若以后仓库改回私有，再按旧流程处理：在服务器生成 SSH key，把公钥加到仓库的 Deploy keys，然后用 `git@github.com:luuumity/emotion-calendar.git` 克隆。

## 4. 安装依赖并构建

```bash
cd /opt/emotion-calendar
npm --prefix server ci
npm --prefix client ci
npm --prefix client run build
npm --prefix server prune --omit=dev
```

构建产物在 `client/dist`，后端启动时会自动托管。

如果 `better-sqlite3` 安装时报 `NODE_MODULE_VERSION` 不匹配，说明 Node 版本变了，重新编译即可：

```bash
npm --prefix server rebuild better-sqlite3
```

## 5. 数据目录与运行配置

```bash
mkdir -p /opt/emotion-calendar/data /opt/emotion-calendar/backups
cat > /opt/emotion-calendar/.env.production <<'EOF'
NODE_ENV=production
HOST=127.0.0.1
PORT=3100
DB_PATH=/opt/emotion-calendar/data/emotion.db
JWT_SECRET_FILE=/opt/emotion-calendar/data/jwt-secret.txt
COOKIE_SECURE=1
EOF
chmod 600 /opt/emotion-calendar/.env.production
```

说明：

- `HOST=127.0.0.1`：只监听本机，外部只能通过 Nginx 访问，避免绕过 HTTPS。
- `COOKIE_SECURE=1`：登录 Cookie 只走 HTTPS。**必须等第 8 步证书生效后再打开**，否则登录会失败。
- `JWT_SECRET_FILE` 不存在时会自动生成，备份 `data/` 时会一起备份。

`.env.production` 和 `data/` 都已在 `.gitignore` 里，不会进仓库。

## 6. 配置 systemd

创建 `/etc/systemd/system/emotion-calendar.service`：

```ini
[Unit]
Description=Emotion Calendar (emotion.cinnamon.xin)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/emotion-calendar
EnvironmentFile=/opt/emotion-calendar/.env.production
ExecStart=/usr/bin/node server/src/index.js
Restart=always
RestartSec=3
User=root
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

启动并检查：

```bash
systemctl daemon-reload
systemctl enable --now emotion-calendar
systemctl status emotion-calendar --no-pager
curl -s http://127.0.0.1:3100/api/health
# 期望输出：{"ok":true}
```

如果启动失败：

```bash
journalctl -u emotion-calendar -n 80 --no-pager
```

## 7. 配置 Nginx

创建 `/etc/nginx/sites-available/emotion-calendar.conf`：

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name emotion.cinnamon.xin;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

启用（只新增这个站点的软链）：

```bash
ln -s /etc/nginx/sites-available/emotion-calendar.conf /etc/nginx/sites-enabled/emotion-calendar.conf
nginx -t
systemctl reload nginx
```

如果服务器不是 `sites-available/sites-enabled` 结构，就把配置放到 `/etc/nginx/conf.d/emotion-calendar.conf`，再 `nginx -t && systemctl reload nginx`。

此时 `http://emotion.cinnamon.xin` 应该已经能打开登录页。

## 8. 申请 HTTPS 证书

```bash
apt-get install -y certbot python3-certbot-nginx   # 已安装可跳过
certbot --nginx -d emotion.cinnamon.xin --redirect --keep-until-expiring
```

certbot 只会改动 `emotion.cinnamon.xin` 这个 server 块，不会影响 homecare。完成后确认自动续期：

```bash
systemctl status certbot.timer --no-pager
```

## 9. 上线验证

```bash
curl -s http://127.0.0.1:3100/api/health
curl -I https://emotion.cinnamon.xin
```

浏览器里按下面流程走一遍：

1. 注册账号 A 和账号 B（用户名只能用小写字母、数字、下划线，3–20 位）。
2. 账号 A 在「月视图」点今天，日视图里把色块推进扭蛋机，填写理由。
3. 账号 A 进入「授权管理」生成凭证，选择「颜色 + 理由」。
4. 账号 B 登录后兑换凭证，能看到 A 的月视图和扭蛋机，但**不能编辑**。
5. 账号 A 撤销凭证后，账号 B 刷新应看到无权限提示。
6. 用两个浏览器或无痕窗口同时登录两个账号，确认数据互不串。

## 10. 日常更新

```bash
cd /opt/emotion-calendar
git pull --ff-only
npm --prefix server ci
npm --prefix client ci
npm --prefix client run build
npm --prefix server prune --omit=dev
systemctl restart emotion-calendar
curl -s http://127.0.0.1:3100/api/health
```

## 11. 备份与恢复

依赖：`apt-get install -y sqlite3`（gzip/tar 系统自带）。

本地备份脚本为 `/usr/local/bin/emotion-backup.sh`（仅存在于服务器，不入仓库），内容如下：

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT=/opt/emotion-calendar
DATA="$ROOT/data"
DEST="$ROOT/backups"
STAMP=$(date +%F-%H%M)
mkdir -p "$DEST"

# 在线备份，不锁库，WAL 里的内容也会包含进来
sqlite3 "$DATA/emotion.db" ".backup '$DEST/emotion-$STAMP.db'"
gzip -f "$DEST/emotion-$STAMP.db"

# 配置与会话密钥一起打包，恢复时不用重新发证书或强制所有人重新登录
tar -czf "$DEST/config-$STAMP.tar.gz" -C "$ROOT" .env.production data/jwt-secret.txt
chmod 600 "$DEST/emotion-$STAMP.db.gz" "$DEST/config-$STAMP.tar.gz"

find "$DEST" -name "emotion-*.db.gz" -mtime +14 -delete
find "$DEST" -name "config-*.tar.gz" -mtime +14 -delete

echo "$(date "+%F %T") backup done: emotion-$STAMP.db.gz"
```

root 的 crontab（每天 03:10，已配置）：

```
10 3 * * * /usr/local/bin/emotion-backup.sh >> /var/log/emotion-backup.log 2>&1
```

从本地备份恢复（把文件名换成要恢复的备份）：

```bash
cd /opt/emotion-calendar/backups
gunzip -k emotion-2026-11-13-1216.db.gz   # -k 保留原压缩包
systemctl stop emotion-calendar
cp emotion-2026-11-13-1216.db /opt/emotion-calendar/data/emotion.db
# 可选：同时恢复配置与会话密钥（避免所有人重新登录）
tar -xzf config-2026-11-13-1216.tar.gz -C /opt/emotion-calendar
systemctl start emotion-calendar
```

以上是**服务器本地备份**（保留 14 天）。异地容灾另有**每日上传阿里云 OSS**（云端永久归档，可选加密，脚本 `scripts/backup-to-oss.sh`），配置手册见 [OSS-SETUP.md](./OSS-SETUP.md)。

OSS 备份的每日 cron（root，与本地备份错开，已配置）：

```
40 3 * * * /opt/emotion-calendar/scripts/backup-to-oss.sh >> /var/log/emotion-oss-backup.log 2>&1
```

从 OSS 恢复（把文件名换成要恢复的备份）：

```bash
source /etc/emotion-backup/oss.env
ossutil64 -e "$OSS_ENDPOINT" -i "$OSS_ACCESS_KEY_ID" -k "$OSS_ACCESS_KEY_SECRET" \
  cp -f "oss://${OSS_BUCKET}/backups/emotion-YYYY-MM-DD-HHMM.db.gz" /tmp/restore.db.gz
gunzip -f /tmp/restore.db.gz
sqlite3 /tmp/restore.db "PRAGMA integrity_check;"   # 应输出 ok
systemctl stop emotion-calendar
cp /tmp/restore.db /opt/emotion-calendar/data/emotion.db
systemctl start emotion-calendar
```

> 若备份是加密版（`.gpg`），先解密再解压：`gpg --batch --passphrase-file /etc/emotion-backup/gpg-passphrase -o /tmp/restore.db.gz -d /tmp/restore.db.gz.gpg`。
> **换新服务器时**：除按本手册重建外，还需把 RAM 策略里的 `acs:SourceIp` 改成新服务器 IP，否则 OSS 上传会被拒绝。

## 12. 常见问题

| 现象 | 排查 |
| --- | --- |
| 访问域名返回 502 | `systemctl status emotion-calendar`、`journalctl -u emotion-calendar -n 80`、`ss -ltnp \| grep 3100`，确认端口和 `proxy_pass` 一致 |
| 登录成功但刷新又变成未登录 | `COOKIE_SECURE=1` 但当前是 HTTP；等证书生效，或临时改成 `0` 验证 |
| `better-sqlite3` 报 `NODE_MODULE_VERSION` | 当前 Node 版本和安装依赖时不一致，执行 `npm --prefix server rebuild better-sqlite3` |
| certbot 失败 | 检查解析是否生效、阿里云安全组是否放行 80/443；`curl -I http://emotion.cinnamon.xin` |
| 端口被占用 | `ss -ltnp \| grep 3100`，改 `.env.production` 的 `PORT` 和 Nginx `proxy_pass` 后重启 |
| 想看接口日志 | `journalctl -u emotion-calendar -f` |
| 数据库锁住 | 确认只有一个服务实例在跑：`ps aux \| grep 'server/src/index.js'` |

## 13. 回滚

```bash
cd /opt/emotion-calendar
git log --oneline -5
git checkout <上一个提交的哈希>
npm --prefix server ci && npm --prefix client ci && npm --prefix client run build && npm --prefix server prune --omit=dev
systemctl restart emotion-calendar
```

数据库结构没有迁移脚本，回滚代码不会影响已有数据。
