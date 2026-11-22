# 会话 Agent 读工具：一致性评审与冷启动落地

> 记录时间：2026-11-22
> 范围：会话 Agent 的读取能力；报告生成暂不改造成 Agent 循环。

## 一、结论

- 分页统一为 `limit + offset`，不再使用 cursor。
- 默认 `limit = 20`；各工具按输出体积设置上限。
- 列表统一返回 `total / returned / nextOffset / items`，`nextOffset` 直接作为下一次的 `offset`。
- 分页必须依赖稳定排序，排序写进工具描述。
- 日期范围统一为闭区间 `[start, end]`。
- 详情模式规则：列表返回截断文本时，若该实体没有独立详情工具，则在同一工具上支持 `id` 取全文。
- `get_days` 继续使用 `includeNotes`，不引入 `compact`，避免和“压缩策略”混淆；语义写进 schema。

## 二、最终工具矩阵

| 工具 | 过滤参数 | 分页 | 详情 | 稳定排序 |
|---|---|---|---|---|
| `get_days` | `start`, `end`, `includeNotes` | `limit` 20/60, `offset` | `get_record(id)` | `day ASC, id ASC` |
| `get_tags` | `start`, `end` | `limit` 20/60, `offset` | `id` 同工具 | `day ASC, id ASC` |
| `get_report` | 无 | `limit` 20/20, `offset` | `id` 同工具 | `period_start DESC, id DESC` |
| `get_facts` | `query` | `limit` 20/100, `offset` | 无 | `pinned DESC, confidence DESC, id DESC` |
| `search_records` | `query`, 可选 `start/end` | `limit` 20/50, `offset` | `get_record(id)` | `day DESC, id DESC` |
| `get_range_stats` | `start`, `end` | 不适用 | `get_days` / `get_record` | 聚合，无分页 |

## 三、本次修复的语义问题

1. `get_days` 增加 `limit/offset` 和 `nextOffset`，不再只返回最早 60 条。
2. `get_days` 的 `indexInDay` 改为按全量有序结果计算，避免 offset 从一天中间开始时重新从 1 计数。
3. `includeNotes=false` 时只返回 `id/day/indexInDay/score/originalScore`，用于长区间扫描。
4. `get_tags` 列表补 `id`、`recordId`、`contentTruncated`；传 `id` 返回完整内容。
5. `get_tags` 增加分页，避免超过 60 条时无法继续。
6. `get_report` 的 `total` 改为真实总数（原来是最多 5 条），补 `returned/nextOffset`，支持分页。
7. 新增 `get_range_stats`：自动按跨度选择天/周/月粒度，返回总览、序列、最低/最高记录、标签计数、理由覆盖率。
8. 新增 `get_facts`：支持关键词和分页，解决预注入只给前 30 条的问题。
9. 新增 `search_records`：按关键词定位记录，返回围绕命中位置的片段。
10. `result_too_large` 的 hint 改为按工具给出，不再统一写“缩到 7 天”。
11. `duplicate_call` 的提示补充“换 offset”。
12. `query` 语义统一：1–50 字、大小写不敏感子串、转义 `%` 和 `_`。
13. 统计字段命名统一：`recordCount` / `recordedDays` 在顶层和序列中同名；`lowestRecords` / `highestRecords`。

## 四、暂不处理，记录备查

- `get_days` 改名为 `get_records`：会影响已有提示词，暂缓。
- `order` 参数（倒序扫描）：可用“最近窗口 + offset”替代，暂不增加。
- `get_report` 的 `scope`、日期过滤：长趋势用 `get_range_stats`，暂不增加。
- 标签类型过滤、分值过滤、facts 的 `minConfidence/pinned` 过滤：暂不增加。
- 跨会话聊天检索：需求未明确，暂不做。
- 通用 SQL 查询工具：不做。
- 报告改造成 Agent 循环：暂不做；报告仍是预注入 + 单次调用。
- 冷启动报告的超长输入裁剪：报告 harness 仍在设计中；本次只落地触发和区间逻辑。

## 五、冷启动规则

- 判定口径：**该用户没有任何单人报告**，而不是“是否点过生成”。
- 存在记录且没有单人报告：无论用户选的是本周、本月还是自定义，首份报告都使用
  `start = 第一条记录日期`、`end = 上海今天`，`period_type = manual`。
- 没有记录：拒绝生成，提示先记录。
- 用户取消确认：不生成。
- 删除所有单人报告后再次生成：重新触发冷启动。
- 后续周报/月报恢复正常周期逻辑。
- 后端在共享的 `generateSingleInsightSync` 中解析冷启动，未来定时任务调用同一函数即可获得相同行为。
- 定时报告本身尚未实现；未来在“开启定时”确认时，应使用同一份冷启动信息提示用户。

## 六、已定与待定

- 已定（2026-11-22）：冷启动全量区间与随后第一份周报**允许重叠**，不跳过本周。用户可能在全量报告后立即想看本周，强行跳过反而少一份报告。
- 待定：冷启动 `end` 是否应该到今天，还是到昨天，避免和“今天”当天的记录重复。
- 待定：定时报告开启确认的文案和默认开关状态。

## 七、落地状态（2026-11-22）

- 读工具改造：已完成。`get_days` / `get_tags` / `get_report` 已统一分页与详情语义；新增 `get_range_stats` / `get_facts` / `search_records`；对话提示词已同步。
- 冷启动后端：已完成。`GET /api/insights` 返回 `coldStart`；`POST /api/insights/single/generate` 在无单人报告时强制全量 `manual`；无记录返回 400。
- 冷启动前端：已完成。无报告时隐藏周期选择器，显示全量区间与记录数；点击后先确认再生成；无记录时按钮禁用。
- 定时报告：**仍未实现**，没有 `sweep-insights.mjs`，也没有“报告定时”设置入口。本次已把 `getSingleColdStartInfo` 和 `generateSingleInsightSync` 从 `routes/insights.js` 导出，未来定时脚本可直接 import 共享函数，从而自动继承“首份全量”的口径。
- 测试：`tools.js` 语义自测 21 项通过；冷启动 API 自测通过（无记录 400、首份强制 manual 全量、第二份恢复 week）；客户端 `tsc --noEmit && vite build` 通过。

## 八、跨轮工具轨迹与压缩（2026-11-22 讨论，待验证）

### 现象
- 真实会话 13：第一轮最后一次调用 14,301 字符，第二轮 6,638 字符；第二轮只继承了 54 + 515 = 569 字的问答，约 8k 字符的工具过程没有进入下一轮。
- 第二轮重新调了一次统计核对数字，并承认上一轮“最长记录”的判断基于截断摘要，无法准确接续。

### 业界参考
- OpenAI Threads / Conversations、Responses `previous_response_id`：服务端保存完整消息与工具项，并按上下文截断。
- Anthropic：`tool-result clearing` 保留“调用发生过”的记录，丢弃可重取的结果；长任务用 compaction；`just-in-time` 只保留轻量标识符。
- Vercel AI SDK：`UIMessage` 持久化完整 tool calls / results，`ModelMessage` 是发给模型的精简视图。
- LangGraph：checkpointer 持久化完整 state，但由调用模型的节点决定注入多少。
- Letta / MemGPT：core memory 常驻 + archival memory 外部检索。
- 《The Complexity Trap》：简单 observation masking 的成本约为 LLM 摘要的一半，效果相当。

### 本轮决定
- 先只做**完整调用链落库**：新增 `chat_trace_events`，记录每轮的 `assistant_tool_calls` 和 `tool_result`，包含 tool_calls、reasoning_content、args、完整 output、status。
- 暂不改变 history 构建、压缩、提示词；暂不注入查询日志。
- 目的：先在真实会话里观察完整轨迹，再决定查询日志怎么组织。

### 后续候选
- 方案 A：回放完整 `user → assistant(tool_calls) → tool(占位) → ... → assistant` 结构。
- 方案 B：每轮压成一条查询日志，以 `system` 注入；最近 3 轮默认保留，更早折叠成索引。
- 倾向 B：避免 `tool_call_id` 配对和 `reasoning_content` 的跨轮协议问题；日志字段至少含工具名、入参、status、returned、nextOffset、关键 ID。
- 压缩：日志独立存、独立取，不依赖 `summary_until_id`；文本压缩继续只处理 user/assistant。

### 待验证
- 规则生成的查询日志是否真的能让 Agent 在追问时更准，而不是增加噪声。
- 日志窗口、老日志索引、与压缩摘要的关系。

## 九、完整轨迹实测（2026-11-22，session 14 / turn 67）

### 实测数据
- 账号 `sunjiayi`（user 2），session 14，turn 67；共 12 个事件：5 个 assistant 决策步、7 次工具调用。
- 轨迹 payload 合计 14,622 字符，工具输出约 9,679 字符，最终回答 402 字。

| 顺序 | 调用 | 结果 |
|---|---|---|
| 1–2 | `get_range_stats(2022-01-01 ~ 2026-11-22)` | 55 条 / 10 天 / 均分 68.7 / 0~100 / 实际 11-12~11-21 |
| 3–4 | `get_days(11-12~11-21, limit=60)` | `too_large`，未返回 |
| 5–7 | 并行 `get_days(11-12~11-16, 30)` + `get_days(11-17~11-21, 30)` | 44 条返 30（nextOffset 30）；11 条返 11 |
| 8–9 | `get_days(11-12~11-16, 30, offset=30)` | 14 条，nextOffset null |
| 10–12 | 并行 `get_record(81)` + `get_record(85)` | 11-15 第 6 颗 34 分；第 10 颗 50 分，均全文 |

### 追问表现
- 下一轮（turn 69）“你还记得刚刚读取的吗”**没有触发任何工具调用**。
- 它基于 402 字最终回答作答，并说“内容还在我这一轮的上下文里”；实际上原始工具结果没有跨轮保留，只有结论摘要。
- 它同时补充“要具体分值和原文，我得取全文才准”，说明模型自己也知道边界。

### 日志原型（约 300 字）
```text
【上一轮查询记录】
- get_range_stats(2022-01-01 ~ 2026-11-22)：55 条，10 天，均分 68.7，最低 0，最高 100，实际范围 11-12 ~ 11-21
- get_days(11-12 ~ 11-21, limit=60)：结果过大，未返回（需缩小范围或 includeNotes=false）
- get_days(11-12 ~ 11-16, limit=30)：44 条，返回 30，nextOffset=30
- get_days(11-17 ~ 11-21, limit=30)：11 条，返回 11，nextOffset=null
- get_days(11-12 ~ 11-16, limit=30, offset=30)：14 条，nextOffset=null
- get_record(81)：11-15 第 6 颗，34 分，全文已读
- get_record(85)：11-15 第 10 颗，50 分，全文已读
```

### 能力边界
- 能保留：查询范围、分页状态、失败原因、已读全文的实体 ID、条数/统计。
- 不能保留：原始 note 内容、`reasoning_content`；要“原话”仍需按 ID 重取。
- 结论：日志改善的是**过程记忆**，不是内容理解；需要真实追问的细节测试来判断是否足够。

### 日志位置澄清
- 方案 A：保留完整 `user → assistant(tool_calls) → tool(占位) → ... → assistant` 结构；日志可作为附加信息插在 assistant 之间，但会和可见的 tool_calls 重复。
- 方案 B（当前倾向）：history 仍只放 user/assistant 文本；每轮另存一条日志，构建 prompt 时以 `system` 块注入最近 N 轮。
- 两者不冲突：数据库已存完整轨迹，未来要切到 A 或 A/B 混合，不需要重新采集。
- 当前没有把日志插进每条 assistant 消息；这是刻意的，避免重复信息、协议配对和压缩耦合。

### 后续测试计划
- 用同一账号克隆 session 14 到测试会话（保留 4 条消息作为上下文），连续追问细节，观察是否调用工具、是否准确、是否编造。
- 重点问题：第 10 颗原话、第 6 颗分值、“刚才哪次调用失败了”、11-15 按分数排序。
- 对照：当前无日志注入 vs 后续有日志注入，比较工具调用次数、回答准确性和 token 规模。

## 十、追问实测（2026-11-22，session 15）

测试方式：把 session 14 的 4 条消息（71–74）克隆到 user 2 的新会话 15，保持同样的上下文，然后连续追问。原始 session 14 未改动。

| turn | 问题 | 工具调用 | 结果 |
|---|---|---|---|
| 75 | 第 10 颗原话 | `get_days(11-15)` + `get_record(85)` | 准确贴出全文，50 分 |
| 77 | 刚才有没有工具调用失败 | `get_days` + `get_record` | **错误**：声称“刚才那几轮我其实没有真的调用工具”“凭预注入摘要拼的”，并怀疑上一轮正确原文；完全没提到 turn 67 的 `too_large` |
| 79 | 第 6 颗多少分 | `get_days(11-15)` | 正确 34 分 |
| 81 | 11-15 按分数排序 | `get_days(includeNotes=false)` | 完全正确：34(6,9,11)、50(5,7,10,12)、66(2,3,4)、82(1,13)、100(8) |
| 83 | 用户提示“是不是结果太大失败了” | `get_days(11-12~11-21, includeNotes=false)` | **仍错误**：坚持“没有失败”“第一次并没有发起那次调用”，并用一次成功的不带理由查询反推“即使带上理由也不会报错”；实际 turn 67 的 `limit=60` 带理由调用确实 `too_large` |

### 关键发现
- 内容型追问（原文、分值、排序）只要模型调工具，结果准确。
- 过程型追问（刚才调了什么、有没有失败）不可靠：模型看不到旧轨迹，会编造自我叙事，甚至在用户给出正确提示后继续否认。
- 这不是“没调工具给模糊结果”，而是“调了工具，但对自身历史给出自信的错误结论”。
- 查询日志正好补这一块：它不提升内容理解，但能让模型准确回答“我查过什么、哪次失败、哪些 ID 已读全文”。
- 日志若只记成功调用、不记失败，仍会出现 Q5 的否认；必须记录 status 和失败原因。
- 当前测试也说明：只在 prompt 里放最终回答，会让模型把自己的总结误当成完整证据，甚至贬低自己上一轮的正确输出。

### 日志注入后的预期
- turn 77 应能回答：“有一次 `get_days(11-12~11-21, limit=60)` 因结果过大失败；后来拆成 11-12~11-16 和 11-17~11-21 两段成功。”
- turn 83 应能回答：“有，就是第一次那次；你提示的范围和原因都对。”
- 内容型问题仍可能需要 `get_record` 取全文，但可以直接按日志里的 ID 调用，减少一次 `get_days` 定位。

### 待办
- 实现规则日志生成器（只读，不注入），用 session 15 的轨迹生成日志。
- 再实现注入（`system` 块，最近 N 轮），在同一测试会话做 A/B。
- 清理测试会话 15 或保留供对照。

## 十一、只读日志生成器（已完成，未注入）

### 文件
- `server/src/lib/trace-log.js`：读取 `chat_trace_events`，按工具类型压成单行；支持单轮和最近 N 轮。
- `server/scripts/trace-log.mjs`：只读 CLI。

### 用法
```bash
# 最近 3 轮
DB_PATH=/path/to/emotion.db node scripts/trace-log.mjs <sessionId>

# 指定一轮
DB_PATH=/path/to/emotion.db node scripts/trace-log.mjs <sessionId> <turnId>
```

### 规则
- 只输出工具名/入参、状态、条数、分页、关键 ID、统计摘要；
- 不输出原始 note、`reasoning_content`、完整 items；
- `too_large` / `duplicate` / `error` 必须显式保留；
- `get_record` 输出 `id / day / 第几颗 / 分数 / 全文字数`；
- `get_days` 输出 `total / returned / nextOffset / 覆盖天数 / 是否含理由`。

### 实测输出（turn 67，约 700 字）
```text
- get_range_stats(2022-01-01 ~ 2026-11-22) → 55 条，10 天，均分 68.7，0~100，实际 2026-11-12 ~ 2026-11-21，粒度=month
- get_days(2026-11-12 ~ 2026-11-21, limit=60) → 失败：结果过大。请减小 limit，或把 includeNotes 设为 false，或缩小日期范围。
- get_days(2026-11-12 ~ 2026-11-16, limit=30) → 共 44 条，返回 30，nextOffset=30，覆盖 4 天，含理由
- get_days(2026-11-17 ~ 2026-11-21, limit=30) → 共 11 条，返回 11，覆盖 5 天，含理由
- get_days(2026-11-12 ~ 2026-11-16, limit=30, offset=30) → 共 44 条，返回 14，覆盖 2 天，含截断理由
- get_record(81) → id=81，2026-11-15，第6颗，34 分，全文 304 字
- get_record(85) → id=85，2026-11-15，第10颗，50 分，全文 554 字
```

### 初步结论
- 原始轨迹 14,622 字符 → 日志约 700 字，保留了失败、分页、ID 和统计。
- 在 turn 77 的窗口里带上 turn 71 的日志，就能回答“有没有失败”；只带最近 1 轮不够。
- 窗口需要覆盖到原始任务，或对更早的失败做一行索引；否则长会话仍会丢。
- 下一步：注入 `system` 块做 A/B，观察 Q2/Q5 是否纠正，以及工具调用次数是否下降。

