# 用量与缓存的存储、口径与展示方案

> 状态：记账已上线（2026-11-23，v16）；用户侧展示未实现，本文只做方案记录。

## 1. 数据存在哪

生产库 `data/emotion.db`，两张表，无单独汇总表。

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

现有汇总脚本：`server/scripts/usage-summary.mjs`。

```bash
DB_PATH=/opt/emotion-calendar/data/emotion.db node server/scripts/usage-summary.mjs 7
```

## 2. 统计口径

- 总 token = 输入 + 输出，与官方 `usage.total_tokens` 一致。
- 工具循环每一步都会重发历史，**输入 token 是累计计费量**，会远大于“内容字数”。
- 开思考时，推理 token 计入 `completion_tokens`，按输出计费，口径不变。
- 聊天的 `prompt_tokens` 是末次请求规模，**不能**用来算总输入；总输入应取 `cache_hit_tokens + cache_miss_tokens`，或新增累计字段后直接读取。
- 缓存命中率 = `hit / (hit + miss)`；`hit + miss` 为空时显示“-”。
- 数据从 2026-11-23 起才有明细；此前历史行新字段为 0，展示时标注起始日期，不回填。

## 3. 给用户展示需要改什么（未实现）

### 3.1 迁移 v17

- `chat_messages` 增加 `prompt_tokens_total`（整轮输入累计）和 `total_tokens`，展示时直接读，不靠推算。
- `insights` 可加 `total_tokens`（现有字段已能算出，可选）。
- 历史行保持 0，不造数。

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

- 聊天按 `chat_messages JOIN chat_sessions` 过滤 `user_id`。
- 报告按 `insights.user_id`（双人按参与关系）过滤。
- 现查聚合即可；图表变慢再加 `usage_daily` 汇总表。
- 按时间过滤若成为瓶颈，补 `chat_messages(created_at)` 索引。

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
