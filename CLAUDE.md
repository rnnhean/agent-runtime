# CLAUDE.md

与 SPEC 冲突时以 SPEC 为准。

## 定位

生产级 Agent 运行时：事件溯源、状态机与中断恢复、多 Agent 委派、MCP 双向、Skill 加载、可观测、判定式评测。零运行时依赖。

## 命令

```bash
npm test         # 42 个测试（含真起 MCP 子进程的端到端）
npm run demo     # 离线演示
npm run eval     # 真实模型评测
npm run serve    # 服务模式 :8790
npm run mcp      # MCP server（stdio）
```

## 不变量（改动前必读）

1. **事件是唯一事实源。** 不许把状态改成「另存一份」。`node_exit` 必须带 state 快照。
2. **`tool_result` 必须能对应到此前发出的 `toolCallId`**，`validate()` 会查。
3. **已完成节点不得重跑。** 恢复从「未消费的 interrupt」所在节点进入。
4. **节点重入必须幂等**，副作用前先看 `ctx.state`。
5. **权限在代码层拦**，不许只靠提示词。
6. **internal 错误立即中断**，不许吞掉或重试。
7. **`POST /api/run` 立刻返回**，长任务后台执行。
8. **子 Agent 只回结论**，不把子过程塞回父上下文。

## 安全

- 凭据只从环境变量读，不打印、不落盘、不进事件。
- `env.example` 只放假值。
- 事件里不得出现凭据；工具输出进事件前如需脱敏要显式处理。

## 编码约定

- ESM + JSDoc，不引运行时依赖。
- 注释解释「为什么」与取舍。
- 新增行为必须配测试；行为变化要同步 SPEC 与 README 的数字。

## 不做

- 训练、微调、模型内部原理
- 多租户、鉴权、K8s、消息队列
- MCP resources / prompts
- 1–5 分打分式评测（无法回归）
