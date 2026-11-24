# 用量与缓存的存储、口径与展示方案

> 状态：记账已上线（2026-11-23，v16）；独立流水 `usage_events` 已上线（2026-11-24，v17）。用户侧展示未实现，本文只做方案记录。

## 1. 数据存在哪

生产库 `data/emotion.db`。**对账以 `usage_events` 为准**，另外两张表是业务表，保留 token 字段用于展示与回填。

**`usage_events`（独立流水，只追加）**

| 字段 | 含义 |
| --- | --- |
| `user_id` | 归属用户；双人报告记在发起人名下 |
| `kind` | `chat` / `single` / `couple` |
| `source_id` | 消息或报告 id，仅用于排查，不建外键 |
| `dedupe_key` | 幂等键：聊天 `chat:{messageId}`、回填 `report:{id}`；报告重新生成留空、按次追加 |
| `model` | 调用的模型名 |
| `input_tokens` | 整轮/整份报告的输入合计（等于 hit + miss） |
| `output_tokens` | 输出合计（含推理 token） |
| `hit_tokens` / `miss_tokens` | 缓存命中 / 未命中 |
| `created_at` | 生成完成时间 |

删除会话或报告不会删除这里的记录（只挂 `users` 外键，随账号删除）。

**`chat_messages`（每条助手回复一行）**

| 字段 | 含义 |
| --- | --- |
| `prompt_tokens` | 本轮**最后一次**请求的 prompt 大小，用于观察上下文膨胀 |
| `prompt_chars` | 本轮最后一次请求的字符数，用于校准估算 |
| `completion_tokens` | 本轮所有步骤的输出合计（含推理 token） |
| `cache_hit_tokens` | 本轮所有步骤的缓存命中合计 |
| `cache_miss_tokens` | 本轮所有步骤的缓存未命中合计 |

**`insights`（每份报告一行）**

| 字段 | 含义 |
| --- | --- |
| `prompt_tokens` | 整份报告所有步骤的输入合计 |
| `completion_tokens` | 整份报告所有步骤的输出合计 |
| `cache_hit_tokens` / `cache_miss_tokens` | 整份报告的缓存命中 / 未命中合计 |
| `tokens` | 历史总数（`total_tokens` 累加），保留兼容 |

现有脚本：

```bash
# 回填 v16 之后的历史（可重复执行）
DB_PATH=/opt/emotion-calendar/data/emotion.db node server/scripts/backfill-usage-events.mjs
# 汇总最近 N 天
DB_PATH=/opt/emotion-calendar/data/emotion.db node server/scripts/usage-summary.mjs 7
```

## 2. 统计口径

- 总 token = 输入 + 输出，与官方 `usage.total_tokens` 一致。
- 工具循环每一步都会重发历史，**输入 token 是累计计费量**，会远大于“内容字数”。
- 开思考时，推理 token 计入 `completion_tokens`，按输出计费，口径不变。
- 聊天的 `prompt_tokens` 是末次请求规模，**不能**用来算总输入；总输入取 `usage_events.input_tokens`。
- 缓存命中率 = `hit / (hit + miss)`；`hit + miss` 为空时显示“-”。
- 数据从 2026-11-23 起才有明细；此前历史行新字段为 0，展示时标注起始日期，不回填。

## 3. 给用户展示需要改什么（未实现）

### 3.1 迁移 v17（已完成）

- 新建 `usage_events`，作为唯一的计费用量来源；聊天、单人、双人三处写入已接入。
- 回填脚本已提供，可重复执行；历史行没有明细的保持不造数。
- 不再给 `chat_messages` 加累计字段：展示直接从 `usage_events` 求和。

### 3.2 只读接口

`GET /api/usage/summary?days=30`，仅返回当前登录用户：

```json
{
  "since": "2026-11-16",
  "chat": { "calls": 54, "input": 175519, "output": 12000, "total": 187519, "hitRate": 0.62 },
  "reports": [
    { "scope": "single", "calls": 3, "input": 90000, "output": 6000, "total": 96000, "hitRate": 0.4 }
  ],
  "daily": [{ "day": "2026-11-20", "chat": 32000, "single": 0, "couple": 0 }]
}
```

- 直接对 `usage_events` 按 `user_id` + `created_at` 聚合，不再关联会话/报告表。
- 现查聚合即可；图表变慢再加 `usage_daily` 汇总表。
- `(user_id, created_at)` 索引已建。

### 3.3 前端

- 位置：「设置 → AI 分析」页底部，与定时报告开关相邻。
- 内容：调用次数、输入/输出/总 token、缓存命中率，按聊天/单人/双人拆分；周期 7 天 / 30 天 / 本月。
- 必须写清两条口径：输入是累计值；缓存命中率自 2026-11-23 起统计。
- 若要显示金额，标注“按当前单价估算，实际以账单为准”。

## 4. 金额估算

接口只返回 token，不返回金额，只能按单价估算：

```
费用 = 未命中/1e6 × 未命中单价 + 命中/1e6 × 命中单价 + 输出/1e6 × 输出单价
```

- 单价不写死在代码里，放配置（按模型区分）。当前价格见 TODO §2.12（2026-11-20 官方价格页）：`deepseek-v4-flash` 输入 ¥1/M、缓存命中 ¥0.02/M、输出 ¥2/M；`deepseek-v4-pro` ¥3/M、¥6/M。
- 估算用累计 `hit`/`miss`/`completion`，聊天的 `prompt_tokens` 不参与。
- 可用 `/user/balance` 每日记录余额差，校准估算系数；该接口无法按用户或请求拆分。

## 5. 边界

- 不做逐 token 明细，只做汇总。
- 不做逐用户预算/限额（另见 TODO §2.10）。
- 思考模式的推理 token 混在输出里，无法单独拆分，展示为“输出”的一部分。
