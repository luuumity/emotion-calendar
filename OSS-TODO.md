# OSS 备份 · 剩余待办清单

已完成：OSS 已开通、Bucket 已创建（香港）、阻止公共访问已开启、版本控制已开启。

下面按顺序做，全部在阿里云控制台完成。

---

## 1. 建 RAM 子用户并保存 AK

- [ ] RAM 控制台 → 用户 → 创建用户
- [ ] 登录名称：`emotion-backup`
- [ ] 访问方式：勾选 **OpenAPI 调用访问**（不勾控制台登录）
- [ ] 创建后立即保存 **AccessKey ID** 和 **AccessKey Secret**（Secret 只显示一次）

## 2. 建最小权限策略

- [ ] RAM → 权限策略 → 创建策略 → 脚本编辑，粘贴下面 JSON
- [ ] 把 `你的bucket名` 替换成实际 Bucket 名（共两处）
- [ ] 策略名称：`emotion-backup-oss`

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "oss:PutObject",
        "oss:GetObject",
        "oss:DeleteObject",
        "oss:ListObjects",
        "oss:ListObjectsV2",
        "oss:AbortMultipartUpload",
        "oss:ListParts"
      ],
      "Resource": [
        "acs:oss:*:*:你的bucket名",
        "acs:oss:*:*:你的bucket名/*"
      ],
      "Condition": {
        "IpAddress": {
          "acs:SourceIp": ["43.103.44.162"]
        }
      }
    }
  ]
}
```

## 3. 给子用户授权

- [ ] RAM 用户 `emotion-backup` → 添加权限 → 选择 `emotion-backup-oss`

## 4. 配生命周期（云端保留 30 天）

- [ ] Bucket → 数据管理 → 生命周期 → 创建规则
- [ ] 前缀：`backups/`
- [ ] 当前版本：30 天后删除
- [ ] 非当前版本：7 天后删除
- [ ] 碎片：7 天后删除

## 5. 配余额与预算告警

- [ ] 费用中心 → 资金管理 → 可用额度预警：`¥10`、`¥5`，短信 + 邮件
- [ ] 费用与成本 → 预算管理 → 月度预算 `¥5`，50% / 80% / 100% 通知

## 6. 配云监控异常告警

- [ ] 云监控 → 报警规则 → 创建规则 → 产品选 OSS
- [ ] 监控对象：备份 Bucket
- [ ] 指标：请求数、公网流出流量（异常升高时告警）
- [ ] 通知：短信 + 邮件

## 7. 账号安全

- [ ] 阿里云主账号开启 MFA

## 8. 把信息发给部署方

- [ ] Bucket 名称：`____________`
- [ ] Region：`cn-hongkong`
- [ ] Endpoint：`oss-cn-hongkong.aliyuncs.com`
- [ ] AccessKey ID：`____________`
- [ ] AccessKey Secret：`____________`

> 这个 AK 只能读写这一个 Bucket，且只能从服务器 IP `43.103.44.162` 使用。交接后随时可以在 RAM 里禁用或删除重建。

部署方收到后会完成：服务器写入 `/etc/emotion-backup/oss.env`（600 权限）、安装 rclone、每日加密上传、30 天云端保留，并做一次恢复演练。

完整说明见 [OSS-SETUP.md](OSS-SETUP.md)。
