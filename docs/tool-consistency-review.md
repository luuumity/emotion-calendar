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

