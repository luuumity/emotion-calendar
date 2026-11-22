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
- ~~实现规则日志生成器（只读，不注入），用 session 15 的轨迹生成日志。~~ 已完成，见第十一节。
- ~~再实现注入（`system` 块，最近 N 轮），在同一测试会话做 A/B。~~ 已完成，见第十一节。
- 清理测试会话 15 或保留供对照。

## 十一、日志注入：聚合 A/B → 成对插入（已上线）

### 文件
- `server/src/lib/trace-log.js`：读取 `chat_trace_events`，按工具类型压成单行；支持单轮、最近 N 轮、按 turn 分组的注入块和开关。
- `server/scripts/trace-log.mjs`：只读 CLI。
- `server/src/routes/chat.js`：调用 `buildTraceLogEntries(sessionId, { minTurnId })`，传给 `buildChatMessages`。
- `server/src/lib/prompts/chat.js`：新增 `traceLogs` 参数，把每条日志插在对应 assistant 回答之后。

### 注入方式
- **成对插入**：`user → assistant → system【查询记录】`，日志跟着它所属的任务走。
- **只注入正文仍完整的任务**：`turn_id > compressed.untilId`；被压缩掉的任务不再插日志，避免“日志在、正文没了”的孤儿日志。
- 最近 **6 个有工具轨迹的任务**；总预算 **2,500 字符**，超了先丢最旧任务，单任务仍超长再按行截断。
- 日志从 `chat_trace_events` 临时生成，不落 `chat_messages`；压缩不会修改它，但压缩水位会决定它是否注入。
- 开关：环境变量 `CHAT_TRACE_LOG=0` 关闭，默认开启。

### A/B 结果（聚合版本，session 14/15）

基线为 session 15（无日志注入），注入后为 session 14（原始会话，messages 85-92）。token 为单轮累计 `usage.total_tokens`。

| 问题 | 基线 | 注入后 | 结论 |
|---|---|---|---|
| 第 10 颗原话 | 2 次调用（`get_days` + `get_record`），18,285 tokens，正确 | 1 次调用（`get_record(85)`），12,092 tokens，正确 | 直接复用日志里的 ID，省一次定位 |
| 刚才有没有工具调用失败 | 2 次调用，19,854 tokens，**错误**：声称没真的调工具、凭摘要拼的 | **0 次调用**，6,142 tokens，**正确**：第一次 `get_days(11-12~11-21, limit=60)` 结果过大 | 过程记忆修复 |
| 你确定没有失败吗 | 1 次调用，13,451 tokens，**错误**：坚持没失败 | **0 次调用**，6,260 tokens，**正确**：确认那次失败，并区分“截断”不是失败 | 用户提示后不再否认 |
| 11-15 按分数排序 | 1 次 `get_days`，12,043 tokens，正确 | 1 次 `get_days`，14,144 tokens，正确 | 没有因日志而幻觉，成本略增 |

### 成对插入实测（session 16）

从 session 14 的原始 messages 67-70 克隆出 session 16（新 turn 93），并复制 turn 67 的 12 条轨迹事件，保证是干净的“有日志、无旧测试污染”会话。

| 问题 | 实际调用 | tokens | 结果 |
|---|---|---|---|
| 刚才有没有工具调用失败 | 0 次 | 5,656 | 正确：一次性拉 11-12~11-21、`limit=60` 结果过大；后改两段并翻页 |
| 你确定没有失败吗 | 0 次 | 5,832 | 正确：确认只有那一次失败，区分“截断”不是失败 |
| 第 10 颗原话 | 1 次 `get_record(85)` | 12,559 | 正确：直接按日志里的 ID 取全文，没有先 `get_days` 定位 |

结论：成对插入与聚合注入在行为上一致；日志放在对应 assistant 回答之后，模型能正确归属，且不会重复全量扫描。

### 结论
- **过程型追问被修复**：Q2/Q5 从“错误否认”变成 0 次工具调用、回答正确。
- **内容型追问更省**：Q1 从 2 次调用降到 1 次，token 从 18,285 降到 12,092。
- **没有诱发幻觉**：Q4 仍调用 `get_days` 拿全量分值，说明日志只提供“查过什么”，没有替代真实数据。
- **成本**：日志块约 1.1–1.8k 字符；Q4 这类本来只需 1 次调用的场景，总 token 增加约 2.1k，属于可接受范围。
- **当前形态**：成对插入 + 压缩水位过滤。被压缩的任务不插日志，因此不会出现孤儿日志；代价是这些任务的日志也更早从 prompt 消失。session 16 验证了成对插入，session 17 验证了真实压缩后的水位过滤。

### 压缩保留区边界（已修复）

原来的切点只按消息条数：`pending.slice(0, pending.length - 6)`，再加摘要字符预算截断。切点可能落在 user 上，导致下一轮历史以一条没有提问的 assistant 开头（孤儿回答），这轮也挂不上日志。

修复方式是在切点计算完之后对齐一次：

- 若保留区第一条是 assistant，就把切点向前回退一条，把那条 user 留在保留区；
- 回退到空则本轮不压，等历史继续增长；
- 连续两条 user（上轮模型失败，只落了 user）不回退，因为下一条仍是 user，不会出现孤儿 assistant；
- 条数切分和字符预算截断走同一段对齐逻辑。

没有改变 `summary_until_id` 的含义、token 估算和摘要输入预算，保留区偶尔会多一条（6~7 条）。

### 备选方案：pair-based（记录，暂不实施）

按 `user + 后续 assistant` 成对分组，只压完整轮次，保留最后 N 轮。它同样能解决孤儿回答，而且与日志的 `turn_id` 单位天然一致。

暂不选它的原因：

- 真实数据存在 user-only：模型调用失败时接口返回 500，user 已落库但没有 assistant（`chat.js` 的 catch 分支），分组逻辑必须处理这种落单消息；
- 保留单位会从「6 条消息」变成「3 轮」或「按轮累计到 6 条」，等于顺手改了上下文体积上限，需要单独决策；
- 摘要字符预算的截断循环也要改成轮感知，否则仍可能切在 user 上；
- 当前只差一个切点不变量，修复面更小、语义零变化。

如果以后要把保留窗口正式定义为「最近 N 轮」，再做 pair-based 迁移；当前的不变量在轮次切分下仍然成立。

### 真实压缩实测（session 17）

构造会话：37 条消息、9,759 字符，早期放一个带轨迹的任务（turn 103，`get_record`），中间 15 组填充对话 + 一条模型失败留下的 user-only 消息，结尾放 session 16 的两个近期任务（turn 136，12 条轨迹）。token 估算约 6.5k，超过 4,000 阈值。

压缩与注入结果：

- 摘要 313 字符，`summary_until_id=132`；
- 保留区第一条是 133（user）。如果不做边界回退，切点会是 133，保留区将从 134（assistant）开始，正好是孤儿回答；
- 不过滤水位时最近轨迹是 `[103, 136]`；带 `minTurnId=132` 后只剩 `[136]`，早期 turn 103 的日志没有注入；
- turn 136 的日志块 563 字符，插在对应 assistant 之后、下一条 user 之前，位置正确；
- 追问「第一次调用失败时 limit 是多少」：0 次工具调用，prompt 6,038 tokens，回答「60」，信息来自注入的日志。

### 剩余风险
- 超过 6 个任务的旧失败不会进入 prompt；原始 trace 还在库，但模型没有工具回看。需要时再加“历史查询索引”或 `get_turn_logs`。
- 被压缩任务不会注入日志，这是有意的取舍；如果用户追问很旧的任务，模型可能不知道当时查过什么。
- 压缩水位过滤已在 session 17 用真实压缩验证；被压缩任务的日志会按设计消失，追问很旧的细节时模型只能依赖摘要，必要时会重查。
- 还没在真实用户的自然长会话上观察过压缩频率和摘要质量；测试会话的填充内容是合成的。
- 当前仍是规则生成日志，不包含原始 note 和 `reasoning_content`；需要原文仍按 id 重取。
- 注入开关是服务端环境变量，不是用户级设置；多用户需要不同策略时再考虑落到用户配置。

