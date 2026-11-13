# OSS 备份 · 进度跟踪

> 本文档只跟踪「做了没」。具体怎么做（定价、JSON、FAQ）见 [OSS-SETUP.md](./OSS-SETUP.md)。

## 设计原则

- **多 Bucket**：每个项目一个 Bucket，数据天然隔离。
- **一个 Bucket 一个 AK**：每个 Bucket 配独立的 RAM 子用户 + AccessKey，最小权限 + 服务器 IP 白名单。一个项目的 AK 泄露不影响其他项目。
- **当前只做 emotion 项目**。其他项目以后按下面「以后加新项目」的模式复制即可。
- 多 Bucket **不会增加费用**：OSS 按存储量/请求/流量计费，不按 Bucket 数量收费。

---

## 当前任务：emotion 项目

已完成：OSS 已开通、emotion 的 Bucket 已创建（香港）、阻止公共访问已开启、版本控制已开启。

- [ ] 建 RAM 子用户 `emotion-backup`，保存 AK（详见 [SETUP §4.1](./OSS-SETUP.md#41-创建用户)）
- [ ] 建最小权限策略 `emotion-backup-oss`（详见 [SETUP §4.2](./OSS-SETUP.md#42-创建自定义权限策略)）
- [ ] 给 `emotion-backup` 用户授权（详见 [SETUP §4.3](./OSS-SETUP.md#43-授权)）
- [ ] 配生命周期：`backups/` 前缀，当前版本 30 天删除（详见 [SETUP §5](./OSS-SETUP.md#5-生命周期规则云端保留-30-天)）
- [ ] 配余额预警（¥10、¥5）+ 月度预算（¥5）（详见 [SETUP §6.1-6.2](./OSS-SETUP.md#61-余额预警)）
- [ ] 配云监控异常告警（请求数、公网流出流量）（详见 [SETUP §6.3](./OSS-SETUP.md#63-云监控异常告警)）
- [ ] 阿里云主账号开启 MFA（详见 [SETUP §7](./OSS-SETUP.md#7-安全加固)）
- [ ] 把 5 项信息发给部署方（详见 [SETUP §8](./OSS-SETUP.md#8-交接给部署方的信息)）

部署方收到后会完成：服务器写入 `/etc/emotion-backup/oss.env`（600 权限）、安装 rclone、每日加密上传、30 天云端保留，并做一次恢复演练。

---

## 以后加新项目（复制这个模式）

每加一个项目（如 homecare、blog），重复以下步骤。**每个项目都独立一套，不与 emotion 共用 Bucket 或 AK。** 详细操作参照 [OSS-SETUP.md](./OSS-SETUP.md) 对应章节，把项目名替换即可。

1. **新建 Bucket**：中国香港、私有、阻止公共访问、版本控制开启（参照 [SETUP §3](./OSS-SETUP.md#3-创建-bucket)）
2. **新建 RAM 子用户**：`<项目名>-backup`，仅 OpenAPI 访问，生成 AK（参照 [SETUP §4.1](./OSS-SETUP.md#41-创建用户)）
3. **新建权限策略**：`<项目名>-backup-oss`，JSON 模板同 [SETUP §4.2](./OSS-SETUP.md#42-创建自定义权限策略)，Resource 换成新 Bucket 名；`acs:SourceIp` 保持 `43.103.44.162`（若新项目在别的服务器，改对应 IP）
4. **授权**：新策略挂到新 RAM 用户（参照 [SETUP §4.3](./OSS-SETUP.md#43-授权)）
5. **配生命周期**：新 Bucket 建一条 `backups/` 前缀、30 天删除的规则（参照 [SETUP §5](./OSS-SETUP.md#5-生命周期规则云端保留-30-天)）
6. **发给部署方**：新 Bucket 的 5 项信息（名称、Region、Endpoint、AK ID、AK Secret）
7. **部署方做的事**：在服务器上为新项目加一套 rclone remote + cron + 恢复演练记录

> 注意：余额预警、月度预算、主账号 MFA 是**账号级**的，配一次就行，不需要每个项目重复。云监控告警建议每个 Bucket 各配一条。
