# 并发改造方案：定时报告并行 + 会话写保护

> 记录时间：2026-11-23
> 状态：**设计文档，未实施**
> 优先级：定时报告并行 **P0**（用户主诉，随用户数线性劣化）；会话写保护 **P2**（低价值优化）

## 一、结论

1. 定时报告从「串行遍历」改为「有界并发 + 扫描与执行解耦」，**并发单位是用户**，不是报告。
2. 队列放**进程内**，不引入数据库任务表。
3. 两个方案共同的前置改造是**给 LLM 调用加超时**，否则并发会从「慢」升级为「永久占坑」。
4. 会话写保护降为 P2，采用 **409 单飞**而不是排队，范围只覆盖“发送消息”。
5. 暂不做：报告级并行、跨进程任务队列、聊天全局 LLM 并发上限。

## 二、现状

### 2.1 定时报告确实是串行的

- [insight-scheduler.js](file:///workspace/server/src/lib/insight-scheduler.js#L301-L326) 的 `tickInsights` 是 `for (const user of users) await runForUser(user, now)`，单个用户失败才 catch 后继续下一位。
- 单份报告是**多次上游调用**：最多 `MAX_REPORT_TOOL_STEPS = 6` 步工具循环，再加一次强制收尾，见 [single-insight.js](file:///workspace/server/src/lib/single-insight.js#L14-L18)。分钟级耗时是常态。
- 调度周期是 `setInterval(run, 60 * 60 * 1000)`，见 [insight-scheduler.js](file:///workspace/server/src/lib/insight-scheduler.js#L328-L337)，且未对齐整点。

三个放大效应：

| 效应 | 说明 |
|---|---|
| 整轮跳过 | `running` 标志（[L16](file:///workspace/server/src/lib/insight-scheduler.js#L16)）在上一轮未结束时直接 `return`，所有用户一起被推迟 |
| 单点阻塞全体 | 没有任何单次调用超时（[llm.js](file:///workspace/server/src/lib/llm.js#L55) 的 `fetch` 无 `signal`），一个用户的上游请求挂住，后面所有用户排队干等 |
| 重试粒度粗 | 失败按小时重试，`MAX_FAILURES = 3`，最坏一个周期要拖三小时 |

量级估算：30 个用户 × 2 分钟 ≈ 60 分钟，正好撞上调度周期。所以问题不只是“慢”，而是**可用性随用户数线性劣化**。

### 2.2 聊天是并发的，但同一会话没有序列化

- [chat.js](file:///workspace/server/src/routes/chat.js#L261) 的 `POST /sessions/:id/messages` 是 async handler；[tool-loop.js](file:///workspace/server/src/lib/tool-loop.js#L64-L102) 内没有全局锁或队列，只有一次请求内部的 `for` 步骤循环。
- 因此：**跨用户、跨会话天然并发**；**同一会话内的两次发送也会并发**（“请求”指一次发送消息的 HTTP 请求，不是 tool call）。

具体时序（同一会话 1 秒内发出 M1「上周我怎么样」、M2「那这周呢」）：

| 时刻 | 请求 A（M1） | 请求 B（M2） |
|---|---|---|
| t0 | 读 `lastAssistantAt`，将 pending 提案置为 expired | — |
| t1 | `await ensureCompressed` | 进入同一段，读到的 `lastAssistantAt` 仍是旧值 |
| t2 | 压缩返回 | 也走一次 `ensureCompressed` |
| t3 | `INSERT` user 消息 M1 | `INSERT` user 消息 M2 |
| t4 | 查 history：`id < M1.id`，只有更早历史 | 查 history：包含 M1，但没有任何 assistant 回复 |
| t5 | `await runWithTools`（约 20s），上下文是“只问了 M1” | `await runWithTools`，上下文是“问了 M1 和 M2，且都没被回答” |
| t6 | `INSERT` assistant A1 | — |
| t7 | — | `INSERT` assistant A2 |

结果：库里顺序是 `M1, M2, A1, A2`，但 A1 不知道 M2 存在，A2 会把 M1 当待答问题重复回答；两轮还可能都生成“提案未确认”的提示块。

修正一点：压缩本身**不会写坏数据**。[compress.js](file:///workspace/server/src/lib/compress.js#L115-L124) 用 `WHERE summary_until_id = ?` 做 CAS，后写失败会回读最新值；最坏只是多花一次压缩调用。

触发面：前端 [ChatPage.tsx](file:///workspace/client/src/pages/ChatPage.tsx#L249-L253) 已经用 `sending` 挡住了同标签页连点。真实场景只剩多标签页/多设备同开、以及“以为没反应又点一次”。

## 三、定时报告并行设计（P0）

### 3.1 设计原则

1. **并发单位是用户**：同一用户内部仍保持 冷启动 → 周报 → 月报 的顺序。
2. **扫描与执行解耦**：`tickInsights` 只做“发现 + 入队”，毫秒级返回。
3. **有界并发**：固定 worker 数，不用无上限 `Promise.all`。
4. **幂等 + 自愈**：依赖现有唯一索引与每小时重扫，不新增持久化。
5. **不改变业务语义**：冷启动门禁、失败计数、推送时机全部沿用。

### 3.2 结构

```
scan（只读 DB，毫秒级）
  → plan（生成用户任务列表，冷启动优先）
  → pool（K 个 worker 消费）
  → 每个任务内部串行：cold → weekly → monthly
```

示意实现（约 30 行，最终以实施为准）：

```js
const inFlight = new Set()      // 任务级去重
let scanning = false            // 扫描级重入保护

const queue = []
let active = 0

function enqueue(task) {
  queue.push(task)
  drain()
}

function drain() {
  while (active < CONCURRENCY && queue.length) {
    const task = queue.shift()
    active += 1
    Promise.resolve()
      .then(task)
      .catch((err) => console.error('[insights] 任务失败:', err))
      .finally(() => {
        active -= 1
        drain()
      })
  }
}

export async function tickInsights({ now = new Date() } = {}) {
  if (scanning) return
  scanning = true
  try {
    if (!hasDeepSeekKey()) return
    const users = /* 原查询不变 */
    for (const user of users) {
      if (inFlight.has(user.id)) continue
      inFlight.add(user.id)
      enqueue(() => runForUser(user, now).finally(() => inFlight.delete(user.id)))
    }
  } finally {
    scanning = false
  }
}
```

`runForUser`、`runCadence`、`generateColdStart`、`pushReport` **都不需要改**。

### 3.3 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| 并发上限 `INSIGHT_CONCURRENCY` | `3` | 环境变量可调，建议 2–5 |
| 单用户任务超时 | `10` 分钟 | 需要 ABORT 支持，见第五节 |

为什么从 3 起步：一份报告最多 6–7 次上游请求，`K = 3` 时峰值约 21 路并发，已经不小。真实瓶颈是上游限流，先取小值观察日志再上调。

### 3.4 行为变化

- 一轮扫描**不再整轮跳过**：已入队的用户继续执行；下一小时只补充新出现的用户。
- 队列在进程内，**重启会丢**排队任务；下一轮扫描会重新发现，靠唯一索引保证不重复出报告。
- 失败重试语义不变：DB 里的 `auto_insight_fail_*` 仍然每小时推进一次，3 次后放弃。
- 冷启动门禁不变：`cold.needed` 的用户本轮只跑冷启动，不跑周/月。
- 同一用户仍不会并发：`runForUser` 内部顺序执行 + [single-insight.js](file:///workspace/server/src/lib/single-insight.js#L193-L218) 的 `generatingUsers` 双保险。
- better-sqlite3 是同步驱动：并发任务只在 `await` 网络时交错，写语句仍由事件循环串行执行，不需要额外数据库锁。

### 3.5 为什么不上数据库任务表

已有三处兜底，足以覆盖重启：

1. 唯一索引 `idx_insights_single_unique` 防重复写入；
2. 每小时重扫自动重新发现未完成的周期；
3. 服务启动先扫一次，补上停机期间错过的周期。

数据库任务表只在“多实例部署”或“报告必须在分钟级送达”时才值得。当前是单实例，属于过度设计。

### 3.6 改动清单

| 文件 | 改动 |
|---|---|
| `server/src/lib/insight-scheduler.js` | `tickInsights` 改为入队；新增 `inFlight`、`queue`、`drain`；`running` 拆成 `scanning` 与 `inFlight` |
| `server/src/lib/llm.js` | `callDeepSeek` 支持 `signal` / 超时（见第五节） |
| `server/src/lib/single-insight.js` | 无需改动 |
| `server/src/routes/insights.js` | 无需改动 |
| 数据库 | 无需迁移 |
| 前端 | 无需改动 |

### 3.7 验收标准

- 模拟 30 个开启定时的用户，`K = 3`，整轮耗时接近原来的 1/3。
- 手动制造一个用户的上游挂起（或 sleep），其他用户仍能正常出报告。
- 并发触发两次 `tickInsights`，不产生重复报告（唯一索引 + `inFlight` 都生效）。
- 同一用户的周报与月报不会同时生成。
- 冷启动已覆盖周期的跳过日志行为不变。

## 四、会话写保护（P2，低优先级）

### 4.1 价值判断

- 前端已挡住同标签页连点；剩下的多标签/多设备误操作概率低。
- 后果是**回答错位**，不是数据损坏（压缩有 CAS）。
- 因此定位为优化项，不阻塞定时并行改造。

### 4.2 方案对比

| 方案 | 实现 | 优点 | 代价 |
|---|---|---|---|
| 排队（promise 链） | Map<sessionId, Promise> | 前端零改动 | 第二条可能等 30–60s，撞 nginx 默认 `proxy_read_timeout`；队列无上限 |
| **409 单飞（推荐）** | Map<sessionId, true> + `finally` 清理 | 简单、不堆积、不会超时 | 前端要处理 409，并把输入框内容还原 |

推荐 409：用户误发时得到明确提示，比静默排队更符合预期。

### 4.3 前置依赖（硬性）

**必须先有单轮超时。** 现在 [llm.js](file:///workspace/server/src/lib/llm.js#L55) 的 `fetch` 没有 `signal`，一旦上游挂死，`finally` 里的清理不会执行，该会话之后的**所有消息都会永久卡住**。只加锁不加超时会比现状更糟。

### 4.4 范围

- 只保护 `POST /sessions/:id/messages`。
- 删除会话、删除消息**暂不纳入**同一把锁；若生成中被删，step 6 插 assistant 可能撞外键级联（当前已存在该风险，不是本次引入）。
- 若后续要求“同会话所有写操作串行”，需要多包 2–3 个调用点，届时再评估。

### 4.5 维护注意

- 该锁是**进程内**的，只在单实例部署有效。多实例/PM2 cluster 下会静默失效，需在代码注释中写明。
- 新加的会话写路由如果需要同样的顺序保证，必须复用同一把锁，否则不变式只覆盖一半。

## 五、公共前置：LLM 超时

[llm.js](file:///workspace/server/src/lib/llm.js#L55) 目前直接 `await fetch(...)`，无超时、无 `AbortController`。建议：

- `callDeepSeek` 增加 `opts.signal`，透传给 `fetch`；
- 未传时使用默认单次超时（建议 120s）；
- 超时抛出可识别的错误（`code = 'LLM_TIMEOUT'`），让上层按普通失败处理；
- 单轮总上限由调用方控制：报告任务 10 分钟，聊天 3–5 分钟。

影响面：定时任务、聊天、会话压缩三处共用，是这两个并发方案共同的底座。

## 六、实施顺序

1. LLM 超时 / AbortController（底座，独立可验证）。
2. 定时报告并行：`inFlight` + 队列 + worker + 环境变量 + 日志。
3. 多用户模拟验证（至少 10 个用户，含一个故意挂起的用户）。
4. （可选，P2）会话 409 单飞 + 前端输入还原。

## 七、暂不处理

- 报告级并行（把周报/月报拆成独立任务）：会破坏冷启动门禁，且同用户双倍 token。
- 数据库任务表 / 跨进程队列：单实例下收益不足。
- 聊天全局 LLM 并发上限：等真实出现上游限流再做。
- 定时任务优先级队列：除“冷启动用户优先入队”外，不做更细的优先级。
- 跨小时积压的监控告警：先观察日志中的整轮耗时。

## 八、待确认参数

| 项 | 建议值 | 说明 |
|---|---|---|
| 定时并发上限 `K` | 3 | 环境变量可调 |
| 单用户任务超时 | 10 分钟 | 需先实现 LLM 超时 |
| 会话保护方式 | 409 单飞 | P2 阶段再实施 |
| 删除会话是否纳入锁 | 暂不纳入 | 记录为已知边界 |
