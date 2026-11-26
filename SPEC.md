# SPEC — 设计契约

> 与代码不一致时，先改这里或先改代码，不能两边各说各的。

## 1. 目标与非目标

### 目标
1. **可恢复**：长任务可中断、可持久化、进程重启后从断点继续，已完成节点不重复执行。
2. **可委派**：子 Agent 以「工具」形式被父 Agent 调用，只回结论不污染父上下文。
3. **可控权**：工具权限在代码层拦截（白名单/黑名单），不依赖提示词。
4. **可组合**：能力以 Skill（SKILL.md）为单位按需加载。
5. **可互操作**：既能作为 MCP 客户端使用外部工具，也能作为 MCP 服务端被外部使用。
6. **可观测**：每一步有结构化事件；跨运行有 Prometheus 指标。
7. **可证明**：判定式评测，真实模型跑。

### 非目标
- 训练/微调、模型内部原理
- 多租户与鉴权（内网 sidecar 定位）
- 分布式部署、消息队列、K8s
- MCP 的 resources / prompts 能力（只做 tools）

## 2. 事件模型

事件只追加，写入 `runs/<runId>/events.jsonl`，每行一个 JSON。

| 事件 | 关键字段 |
|---|---|
| `run_started` | task, mode, agent |
| `skills_selected` | skills[] |
| `node_enter` / `node_exit` | node, outcome, **state 快照** |
| `llm_response` | turn, text, toolCalls[], usage |
| `tool_result` | turn, result{toolCallId,name,ok,error{kind,message},durationMs} |
| `interrupt` | node, question, options[], context |
| `resume` | node, answer |
| `run_finished` | status(ok/failed/interrupted), answer, stopReason |

不变量（`validate()` 校验）：
1. 首条必须是 `run_started`，恰好一条。
2. `run_finished` 最多一条。
3. 每个 `tool_result.toolCallId` 必须对应此前 `llm_response` 发出的调用，且不得重复回填。
4. 每个 `resume` 必须对应此前未消费的 `interrupt`。

## 3. 状态折叠

`fold(events) → state`，纯函数。state 含：runId、task、status、node、turns、usage、pendingInterrupt、children、toolCalls、stopReason。

**状态不单独持久化。** `node_exit` 里的 state 快照用于重建节点间共享状态。

## 4. 工具

```ts
interface Tool {
  name: string;
  description: string;      // 写清何时用/何时别用
  parameters: JsonSchema;
  parse?(args): {ok, value?, error?};   // 校验与转型，先于执行
  run(args, ctx): Promise<unknown>;
  timeoutMs?: number;       // 默认 30000
  retries?: number;         // 默认 0，仅 network/timeout 生效
  tags?: string[];
}
```

错误分类与处理（`ERROR_POLICY`）：

| kind | 回给模型 | 重试 | fatal |
|---|---|---|---|
| validation | ✅ | ❌ | ❌ |
| business | ✅ | ❌ | ❌ |
| network | ✅ | ✅ ≤2 | ❌ |
| timeout | ✅ | ✅ ≤1 | ❌ |
| permission | ✅ | ❌ | ❌ |
| internal | ❌ | ❌ | **✅** |

权限判定顺序：`deny` 优先于 `allow` 优先于存在性检查。

## 5. 循环

`runLoop`：每轮 `llm.chat` → 写 `llm_response` → 若有 toolCalls 则逐个执行并按策略处理 → 写 `tool_result` → 回填。达到 `maxTurns` 或模型无工具调用时结束。

`stripThinking` 默认 true：丢弃 `thinking` / `redacted_thinking` 块后再进历史。

## 6. 状态机

```ts
defineWorkflow({ name, nodes, entry, maxTransitions = 20 })
// node: (ctx) => Promise<{goto?, done?, output?, state?}>
```

- `Interrupt` 继承 Error；节点内 `throw new Interrupt(q, {options, context})`。
- 调度器捕获后写 `interrupt` + `run_finished{status:'interrupted'}`，正常返回（进程可退出）。
- `resume`：读事件 → 找未消费 interrupt → 从该节点重入 → `ctx.humanAnswer` 为答案。
- 节点重入必须幂等，用 `ctx.state` 判断是否已执行过副作用。
- 已完成的 run 再 resume：直接返回现状，不执行任何节点。

## 7. Skill

目录下 `SKILL.md`，frontmatter：

```
---
name: order-lookup
description: 查询订单状态与物流（什么时候用）
tools: [query_order, query_logistics]
---
正文指令
```

- `loadSkills(root)` 递归加载（≤2 层）
- `selectSkills(skills, task, max=3)` 关键词/二元组打分
- `skillsToolAllow(skills)` 生成工具白名单；无技能时返回 undefined（不限制）

## 8. MCP

**客户端**（`McpClient`）：stdio + JSON-RPC。流程 `initialize` → `notifications/initialized` → `tools/list` / `tools/call`。工具命名加 `mcp__` 前缀。远端 `isError` 转为抛错（kind=business）。

**服务端**（`src/mcp/server.mjs`）：实现 `initialize` / `tools/list` / `tools/call` / `ping`。未 initialize 时调用工具返回 `-32002`。

## 9. 服务接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | ok / version / mode / runs / uptime |
| GET | `/metrics` | Prometheus |
| GET | `/api/runs` | 最近 50 条 |
| GET | `/api/runs/:id` | trace（`?raw=1` 附原始事件） |
| POST | `/api/run` | 202 + runId，后台执行 |

`POST /api/run` **必须立刻返回**，不得等待执行完成。

## 10. 指标

`harness_runs_total/_ok/_failed/_interrupted`、`harness_tool_errors_total{kind}`、`harness_turns_total`、`harness_tool_calls_total`、`harness_input_tokens_total`、`harness_output_tokens_total`、`harness_run_duration_seconds_sum/_count`、`harness_success_ratio`。

## 11. 评测

真实模型，判定式。每个 case 声明 `mustCall` / `mustIncludeAny` / `mustNotInclude`，全部满足才通过。

| case | 关键验收 |
|---|---|
| query_shipped | 调 query_order + query_logistics；答复含物流状态 |
| order_missing | 调 query_order；说明不存在 |
| bad_format | 调 query_order；指出格式问题 |
| policy_compensation | 调 query_order + search_policy；引用补偿规则 |

## 12. 验收标准

1. `npm test` 42 项全绿
2. `npm run demo` 展示技能加载 / 错误分类 / 中断恢复
3. `npm run eval` 真实模型 4/4
4. `docker run` 后 `/health` ok、`/api/run` 返回 runId、`/metrics` 有数
5. MCP server 能被客户端完整握手并调用工具
