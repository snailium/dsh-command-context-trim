# dsh-command-context-trim

[English →](README.md)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 增加一个**不调用任何模型**的 `/trim` 命令：
把对话里最旧、最不重要的一段上下文裁掉，让会话能切到**窗口更小的模型**上继续跑。

## 为什么需要它

把长会话从云端大窗口模型切到本地小窗口模型后，下一次请求会超出新模型的窗口。常规做法是切换前先 `/compact`，
但 compaction 的本质是**摘要**：它必须让摘要请求本身也塞进（已经变小的）窗口，而摘要的输入正是那段要压缩的历史——
于是它常常因为和原请求同样的原因失败。DSH 内置的溢出自动恢复同理：它也是用 routed 模型去做摘要，本地窗口太小就一样失败。

`/trim` 完全不依赖模型：它先按目标模型重新测算当前请求，选出**最旧的、工具调用/结果配对平衡的**一段，刚好释放到预算
以内，再用一条极短的占位消息把这段遮蔽掉。两次同步 append，零次 LLM 调用——所以它在“所有请求都失败”的场景下照样能用。

## 安装

```bash
dsh plugin --profile web add dsh-command-context-trim          # 从 npm 安装
dsh plugin --profile web add file:/path/to/dsh-command-context-trim   # 从源码
```

包内声明了 `dsh.bundle.patch`，`dsh plugin add` 会自动把它加进 profile 的 `dsh.profile.bundles`，并组合其 insert 行
（插件 id `context-trim`）。重启对应 profile 后，斜杠菜单里会出现 `/trim`。

## 用法

```
/trim                       按当前/待切换模型的窗口裁到预算内
/trim check                 只报告计划，不修改任何东西
/trim 32k                   指定 32768 token 预算
/trim lc:/models/qwen.gguf  按指定 route 声明的窗口裁
```

典型流程：切到本地小模型 → 执行 `/trim`（也可以在切换前执行：命令会读取最新的 `model/selection` 意图）→ 继续对话。

## 实现要点

一次裁剪 = 两次**紧邻**的 append：

1. `compaction/prune` —— token meter 的 **shadow-price 记账**。meter 的持久化投影是 O(1) 的，无法为被替换的范围重新计价，
   所以替换事件前必须有一条声明被遮蔽范围精确价格的计量事件，否则投影按 0 增量记账，上下文占用显示会漂移。
2. `user/message` + `surfaceOp:{op:'replace',start,end}` —— 替换本体，`sourceEventSeqs` 覆盖全部被遮蔽节点。

`user/message` 是**空闲态唯二合法的 surface 事件类型**：`assistant/message` 需要 open step，`tool/result` 替换需要 open turn，
而“回合之间”正是用户需要裁剪的时刻。

由此带来的性质：

- **人类记录不受影响**：替换是 model-only，transcript 只读 append 来源事件；原始内容完整保留在持久化日志里，可审计、可人工恢复。
- **绝不切断工具调用/结果配对**：切点由 `@deepseek-ai/dsh-compaction` 的 `toolPairingBalancedBefore/After` 决定。
- **与其它机制互斥**：命令在 `agent.runMaintenance()` 内执行（非 idle 直接失败），不会与回合、`/compact`、自动压缩交错；
  存在未闭合的 `compaction/start` 时也会拒绝执行。

## 撞墙自动 trim

`autoTrim`（默认开）让同一套"无模型调用"的裁剪在无人值守时发生：用 **`prepend`** 注册的 `agent/request-error`
监听器在 `CONTEXT_WINDOW_EXCEEDED` 时裁剪并请求重试。

```
请求撞墙
  ├─ prepend: context-trim   → 裁剪一段，零模型调用 → retry       ← 能腾出空间时由它解决
  └─ next(): compaction-basic → 先 prune 工具结果再摘要（LLM）     ← 只在 trim 无能为力时
```

为什么 `prepend` 是关键：`agent/request-error` 是 Cordis 的 **waterfall**，compaction 也在同一事件上注册了自己的
摘要恢复；Cordis 按注册顺序存放监听器，`{ prepend: true }` 会 `unshift` 到最前，所以即使 compaction 是稍后在
agent-preset 的 isolate realm 里挂载的（web profile 里就是这样），本插件依然先执行。不调用 `next()` 即否决该次
摘要。

**范围刻意收窄**：只有 `CONTEXT_WINDOW_EXCEEDED` 才触发；其它请求错误、普通阈值 compaction（`agent/pre-step` 压力路径）、
`/compact`、工具结果 pruner **一律不碰**（有测试锁定注册的监听器集合）。

每轮溢出 epis 的额度由 `maxAutoTrimRetries`（默认 1）限制，收到完成的 assistant 消息或 agent 空闲即重置。
代价如实说：自动 trim 是**丢弃**最旧一段而不是摘要它——在小窗口下这正是要点，但被丢的内容只会变成一条占位标记。
`/compact` 仍在，原文也仍在会话日志里。

## 保护集与选段策略

保护：开头 `protectHeadNodes`（默认 1，即任务声明）、末尾最近 `retainRatio` 窗口（下限 `minTailTokens`）、以及最后一条消息永不裁剪。
在保护集之间采用**最旧优先、够用即止**：从最旧的平衡切点开始，只增长到刚好释放够 token。

## 兼容性

| Harness | 状态 |
|---|---|
| 0.1.2-rc.1（`latest`） | ✅ 全套测试通过 |
| 0.1.5-rc.2（`next`） | ✅ 全套测试通过 |

两处 0.1.5 变更已在不做版本号判断的前提下兼容：

- **替换标记改名**：`{op:'replace', start, end}` → `{op:'replace', startSeq, endSeq}`。插件首次使用时用一个一次性游离 session 探测本机 harness 接受哪种形状，再按该形状写入。
- **system prompt 从 header 搬到了 surface**（0.1.5 作为 `system/message` 节点 0）。system 节点被当作**屏障**：永不裁剪、任何被裁区间都不得跨越它；同时 `protectHeadNodes` 只统计非屏障节点，因此"保护头部"保护的仍是**用户的任务声明**，而不是 system prompt。

因此"固定请求开销"的含义变为工具 schema + 其它非 surface 请求数据（0.1.2 上还包含 system prompt）；裁剪预算本身不受影响，因为它来自 token meter 的总量。

## 配置

在 profile patch 的 `context-trim` 行上覆盖（`cordis.patch.yml` 里列出了全部默认值）：

`targetRatio`(0.9)、`reserveOutputTokens`(8192)、`retainRatio`(0.16)/`retainTokens`、`minTailTokens`(2048)、
`protectHeadNodes`(1)、`allowTailTrim`(true)、`markerSlackTokens`(64)。

预算公式：`budget = floor((contextWindow - reserveOutputTokens) * targetRatio)`。

## 局限

- 它是**丢弃**而不是摘要。需要“浓缩保留”时用 `/compact`；两者互补（先 `/trim` 会让随后的 `/compact` 更省、更易成功）。
- **无法缩减固定开销**（system prompt + 工具 schema 不在 surface 上）；如果固定开销本身超预算，命令会明确报错而不是假装成功。
- v1 **没有 `/untrim`**：把旧内容重新变回 surface 需要 append `assistant`/`tool` 事件，而那只在 open turn 内合法。
- 计价使用 token meter 的启发式估算（与 `/compact`、GUI 上下文条一致），与提供商真实 usage 略有偏差。

## 开发与验证

```bash
npm install            # 本插件依赖的 harness 契约已固定为 devDependencies
npm test               # node --test
npm run link:harness   # 也可改为从本地 dsh 安装的依赖闭包解析 @deepseek-ai
```

已验证：34 个测试全部通过（选段算法、参数解析、真实 Session 上的 surface 改写与日志重放、插件命令注册与端到端裁剪，以及用**真实 `ctx.tokenMeter`** 验证「实测降幅 == 声明的 shadow price」和「新进程重放裁剪后日志得到完全一致的总量」）；
隔离 `DSH_HOME` 安装后 dependency 与 bundle 层均正确 reconcile；`dsh --dump-config` 中出现 `context-trim` 行；profile 启动无加载错误。
CI 在 Node 22/24 上跑同一套测试；发布通过 `.github/workflows/publish.yml`（手动 `workflow_dispatch`）。
npm 0.2.0（新增撞墙自动 trim），并已在隔离 profile 里从 registry 安装验证；尚未执行：Web GUI 里的真实小窗口端到端验证（mock provider 与隔离实例已就绪）。

## License

MIT
