# dsh-command-context-trim

[English →](README.md)

<!-- synced-with-readme: 0.6.4 -->

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 增加一个**不调用任何模型**的 `/trim`：
在真正溢出之前，把对话里最旧、最不重要的一段上下文裁掉，让会话能切到**窗口更小的模型**上继续跑；同时可以按路由
调优 DSH 自己的 **compaction 触发点**与**工具结果裁剪阈值**。

> 本文是 `README.md` 的中文同步版：**同结构、同命令、同默认值、同公式、同验证事实**（长段落做了压缩翻译）。
> 版本号见上方 `synced-with-readme` 标记，`test/docs-sync.test.js` 会检查它与 `package.json` 一致、且关键内容不漂移。

## 为什么需要它

把长会话从大窗口的云端模型切到小窗口的本地模型时，**下一个请求**就会超过新模型的窗口。既有做法是切换前先
`/compact`——而这正是痛点所在：compaction 是**摘要**，它的摘要请求必须既能塞进（已经变小的）窗口，又要容纳那段
正被摘要的内容；窗口越小，摘要越容易失败，或摘要质量越差（要压缩的信息越多）。`/trim` 换了一条路：**先把最旧的
上下文裁掉**，不调用模型、不产生摘要，于是后续 `/compact` 更便宜、也更容易成功。

## 它给本地模型带来什么

DSH 的压缩触发点是
`min(thresholdRatio × contextWindow, contextWindow − R − headroom)`，其中 `R` 是该路由自己的输出预留，而
`headroom` **固定为 65536**，与窗口大小无关。在百万 token 的云路由上这几乎无所谓；在本地卡上它决定一切：

- 131072 窗口：固定 headroom 让触发点落在 **37.5 %**，而不是比例想要的 80 %⇒压缩来得又早又频繁；
- 本插件把该路由的 headroom 设为 0（比例重新说了算）⇒触发点回到 **104857**（80 %）；
- 效果就是**更少、更晚**的压缩：同样一段工作，压缩次数下降、每次压缩要处理的量更小。

### 什么时候它不划算

上面那份收益是"**更少、更晚**"的收益，只在 stock headroom **把一个本可支持的触发点压低了**的地方存在。当 stock
headroom 直接把触发点**关掉**时（消息预算 ≤ 65536），把它打开并不会减少已有的压缩，只会**增加**事件——我们实测
同一条任务从 15 次压缩涨到 24 次。因此 `tuneStockDisabledRoutes` 默认为 `false`：这类路由**保持原样**，继续靠
`/trim` 与 DSH 自己的溢出路径兜住窗口。

### preset 路线是上锁的，而且必须保持可解析

会话一旦开始，它的 preset 就固定了（`agent-preset/locked`），**fork 也继承父会话的 preset 并被同样上锁**：
`buildForkSeed` 会把父会话的 `turn/start` 事件复制进子会话（`dsh-session/lib/index.js:884-893`），而 fork 本身要求
父会话已有一个**完成的 turn**，于是子会话的 `turnBoundary.lastTurn > 0`⇒同样换不了 preset。因此：

- **想要新参数**：让进程**重启**即可——会话的 preset **id 是粘住的**（它来自会话的 `agentPreset` 投影，而
`assertPresetUnchanged` 会拒绝另一个 id），但**该 id 背后的定义在每次 adopt 时都会被重新解析**：
`createOrAdopt` 与 `resumeObserved` 都会调用 `composeAgent(presetForObservation(observation))`，再把新组合交给
`agents.resume`，而 `retain(id)` 返回的是**当前定义所激活的那一代**。所以"改 preset 时没有在运行"的会话，
**只要 resume 就会吃到调优**——**不需要 fork**。

只有一种情形需要 fork：**改定义时会话仍在运行**。活着的 agent 绑在它当初组合的那一代上，那份绑定会让旧 realm 保持
存活，所以改动到不了它⇒这时才 fork（或等下一次重启）。fork 是**新 session id**、且自身也被锁（继承父会话的
`turn/start`）——但这对它无害，因为它已经在跑调优后的值。

### 该用哪条路线

两条路线都能设置全部压缩参数——触发点、pruner、**以及摘要模型**（`summarizationProvider` / `summarizationModel`
就是 `compaction-basic` 上的普通键，可用 `modelPolicies` 按路由设置）。**优先 profile 平面**：它每次启动都能重新调优、
且不涉及 preset 的持久性负担。

| 路线 | 覆盖 |
|---|---|
| **profile 平面**（headless / tui：`autoTuneCompaction`、`/context-tune tune`）| 自动路径**确实会触发**：host 平面拥有 agent|
| **preset 平面**（web：`/context-tune preset inplace` + `check` + fork）| **手动**：会话 agent 在各自 preset 域里创建，其生命周期事件**到不了 host 平面**（已实测）|

## 安装

```bash
# 从 npm
dsh plugin --profile web add dsh-command-context-trim

# 从 checkout
dsh plugin --profile web add file:/path/to/dsh-command-context-trim
```

## 用法

```
  /trim                                 # 按当前模型窗口裁剪
  /trim check                           # 只报告计划，不改动
  /trim 32k                             # 指定 32768 token 预算
  /trim 40000                           # 指定 40000 token 预算
  /trim provider:model                  # 按另一条路由的窗口计算
  /context-tune tune [check]            # 用当前活跃路由重新调优本进程的 compaction 行（profile 平面）
  /context-tune preset [check|list|default|inplace|p:m]
  /context-tune rescue <id> [--from <donor>] [--untuned]
  /context-tune reset [check] [preset-id] # 去掉本插件写进 preset 的调优行
```

**想撤销调优**用 `/context-tune reset`：它删掉本插件写进 profile 补丁的那些**标记块**，于是每个 preset 回到它
  自己的定义。不带参数就是列出并删除全部；带 preset id 只删那一个；加 `check` 只报告不写。它靠标记块**精确**认出
  哪些行是自己写的（不靠匹配描述文字），所以**别的工具写的块会被列出来但不动**。preset 锁依然有效——删除同样只对
  新会话、或重启之后的会话生效。

  `/context-tune preset` 的完整形式：

```
/context-tune preset              # 依据 profile 里配置的路由生成并落地一个调优 preset
/context-tune preset inplace      # 覆盖**基础 preset 自己的 id**，而不是新增一个 id（见下）
/context-tune preset check        # 打印将生成的行 + 路由覆盖率，不写任何东西
/context-tune preset list         # 会覆盖哪些路由、各自拿到什么触发点
/context-tune preset default      # 同时把它设为**新会话**的默认 preset
/context-tune preset p:m          # 本次用 p:m 作为摘要路由
/context-tune rescue <id>         # 用同 id 重建丢失的 preset（--from <donor>、--untuned）
```

`/context-tune preset check` 是**过期信号**：它统计当前 preset 覆盖了多少条路由，并对**消息预算 ≤ 64K 却未被覆盖**的路由
给出明确告警——那是唯一一种"继承顶层调优值反而**打开**压力触发"的情况。新增模型后跑一次 `check`，报缺口就重跑
`/context-tune preset inplace`：

```
coverage: 4 route(s) configured, 3 covered by this preset, 1 not covered.
⚠ uncovered SMALL route bonsai-8gb//models/mtp-lean.gguf (40960 − 8192 ≤ 65536): without a policy it inherits the
  tuned top level, which enables the pressure trigger on a route where that measured slower. Re-run /context-tune preset inplace…
```

## 工作原理

一次 trim 是两次**同步相邻**的追加：先写入一条替换消息（带 `plugin:dsh-command-context-trim` 来源标记），
再写入 token meter 的测量事件；两者之间没有 await，所以模型不会看到中间态。裁剪按**从最旧开始**的优先级进行，
最后一条消息降级为"尽量不裁"，用户指令始终受保护。

## 上下文墙上的自动裁剪

`autoTrim`（默认开启）让同样的免模型裁剪在无人敲命令时发生：一个 **prepend** 的 `agent/request-error` 监听器
响应 `CONTEXT_WINDOW_EXCEEDED`，裁剪，然后请循环重试。它**不在普通压缩时触发**。

```
请求失败（上下文墙）
  → 裁剪并重试（最多 maxAutoTrimRetries 次）
  → 仍失败⇒交给 DSH 自己的压缩路径
```

## 受保护的内容

用户指令（最后一条消息）**尽量不裁**；`protectHeadNodes`（默认 1）保护开头的节点；保留尾部（`retainRatio` /
`retainTokens` / `minTailTokens`）逐字保留最近上下文；`allowTailTrim` 控制最后手段的层级。

## 兼容性


### 该装哪个插件版本

这里没有 peer 依赖来强制这条规则，所以只能写在这里、需要人去读：**dsh 0.1.5 只能配本插件的 0.1.x。**
0.2.0 起直接装最新版。0.1.7 和 0.2.0 差别不大，同一个构建两边都能用。

| dsh | 装哪个 | 原因 |
|---|---|---|
| 0.1.2-rc.1 | `0.1.x` | devDependency 里钉死的下限 |
| 0.1.5-rc.2 / 0.1.5-rc.3 | **只能用 `0.1.x`** | 设置卡片需要 `configForms` 和 schemastery 的 `.volatile()`，0.1.5 两样都没有 |
| 0.1.7-rc.2 | 最新版（0.6.x） | 到 0.2.0 为止，本插件做的事都没变 |
| 0.2.0-rc.2 | 最新版（0.6.x） | 第一条能在这条线上正确保存卡片写入的版本 |

0.1.5 被单独划出来而不是"降级可用"：它早于卡片契约的两半。它的 web 宿主不提供 `configForms` 服务，没有表单可渲染、
也就无处可存；它的 schemastery 早于 `.volatile()`，而那是把字段放上卡片的唯一条件。插件在那里仍然能加载、`/trim`
仍然能用——客户端半边会检测到缺失的服务然后什么都不注册，而不是在页面里抛错——所以失败形态是"卡片悄悄不出现"，
而不是启动报错。这是最不该让人去猜的一种失败，所以写在这里。

0.2.0 线上真正变化的是**保存路径**。0.1.7 时代的构建会把布尔值按字符串 `"true"` 暂存，`.volatile()` 过去会放行；
0.2.0 按 schema 校验这次操作并带内拒绝——没有 HTTP 错误，console 也没有输出。**0.5.0** 修好了，它写的是正确类型的值。
所以在拆分两行和改名之前，0.2.0 就已经需要 0.5.0 以上了。

**session format v4 下的标记来源。** 替换消息携带来源 kind `plugin:dsh-command-context-trim`——v4 要求的
`plugin:<plugin id>` 形状——因为 0.1.7 的准入路径会拒绝已退休的 `{kind: 'plugin'}` 包装，报
`format v4 message requires a producer-owned source kind`。

## 设置卡片

Plugins 页面上的卡片显示的是**生效值，而不是"是否覆盖"**：部署没设过的字段会显示插件真正会用到的默认值——因为一片空白
的控件正是"我的新模型为什么还没调优"变成无解问题的原因。卡片分两个分区：**压缩**（触发阈值、摘要路由、两个自动调优
开关）与**裁剪**（工具结果裁剪阈值），而裁剪阈值是"**选值下拉 + 数值框**"：只有选 `Custom` 时数值框才出现。

| 选值 | 落到设置面的值 |
|---|---|
| `Disabled` | `0`（不动 pruner）|
| `Auto` | `auto`（按路由窗口推导）|
| `Custom` | 你填进数值框的字符数 |

`运行时自动调优压缩阈值` 上以**粗体**写着唯一要紧的前提：**仅限 headless profile——web profile 需使用 `/context-tune preset` 命令来调优**
（web 里会话 agent 在各自 preset 域内创建，其生命周期事件到不了 host 平面）。开关用的是壳子自带的 `Switch` 原语；选值框是
原生 `<select>`（原语没有 Select）。

## 配置

在 profile 补丁的 `context-trim` 行上覆盖（随包 `cordis.patch.yml` 列出了完整默认值）：

| 键 | 默认值 | 含义 |
|---|---|---|
| `targetRatio` | `0.9` | `budget = floor((contextWindow - reserveOutputTokens) * targetRatio)` |
| `reserveOutputTokens` | `8192` | 留给模型自己回复的输出空间。它与服务端自己的 `maxTokens` 之和要落在真实窗口内：一个 32k 的服务若 `maxTokens: 16384`，即使提示词都装得下，提示词 + 输出也会耗尽窗口 |
| `retainRatio` / `retainTokens` | `0.16` /—| 逐字保留的最近尾部（两种形式互斥）|
| `minTailTokens` | `2048` | 该尾部的绝对下限 |
| `protectHeadNodes` | `1` | 永不裁剪的开头节点数 |
| `allowTailTrim` | `true` | 启用层级 2–3（伸进保留尾部；最后手段可含末条消息）。`false` 表示只做层级 1，保留尾部成为硬边界 |
| `markerSlackTokens` | `64` | 加在计价标记上的余量，保证裁剪后的请求仍在预算内 |
| `autoTrim` | `true` | 在 `CONTEXT_WINDOW_EXCEEDED` 时自动裁剪；**绝不在普通压缩时触发** |
| `maxAutoTrimRetries` | `3` | 每次溢出允许的自动裁剪次数，之后交给压缩 |
| `autoTrimShrink` | `0.5` | 重复溢出后，按被拒请求的这个比例重新取预算目标（声明窗口有误时的几何下降）|
| `preferInPlacePrune` | `true` | 规划任何区间之前，先就地瘦身过大的工具结果；能用到官方 pruner 时就用它 |
| `compactionTargetRatio` | `0.8` | `/context-tune preset` 写进 preset 的触发比例（只塑造 preset，从不影响本插件自己的裁剪）|
| `compactionRoute` | 未设置 | 生成 preset 的摘要调用所用的可选 `{provider, model}` |
| `tuneStockDisabledRoutes` | `false` | 为 `false`（默认）时，*stock* 配置里没有压力触发的路由保持原样——在那里打开触发只会增加压缩事件（见*什么时候它不划算*），所以免模型的 `/trim` 与 DSH 的溢出路径继续兜住窗口。设为 `true` 才会一并调优这类路由 |
| `prunerThresholdChars` | `auto`（`DSH_TRIM_PRUNER`）| 工具结果裁剪阈值。`auto` 按路由派生为 `max(8192, min(32768, 2 × (contextWindow − maxTokens)))`（各路由取最小），小窗口下一次整文件读取因此不会被裁掉（DSH 的 stock 值是 `8192`）。整数覆盖它；`0` 表示退出、保持不动。与 compaction 行同一平面，因此同样的可达性规则适用——web profile 把 pruner 放在每个会话的 preset 里，插件会报告这一点而不是写入。**小窗口**上这是最关键的杠杆（见*什么时候它不划算*）；**压力触发已启用**时它会放大提示词，那里要三思 |
| `autoTuneCompaction` | `false` | 重新调优本进程的 compaction 行（仅在 compaction 位于 profile 平面时）。web 或生产 profile 应该设置**这一项**（通过设置卡片或补丁层）；覆盖它的 `DSH_TRIM_AUTO_TUNE` 环境变量只用于**自动化/CI** |
| `pruneThresholdChars` / `pruneHeadChars` / `pruneTailChars` | `8192` / `4096` / `1024` | 就地瘦身的预算，镜像 DSH 自己的 pruner 默认值 |

环境变量（供自动化/CI 覆盖对应配置项）：`DSH_TRIM_AUTO_TUNE`、`DSH_TRIM_PRUNER`、`DSH_TRIM_TUNE_STOCK_DISABLED`。

## 权限与失败边界

插件触碰了什么，写在这里以免审阅者靠猜：

- 只写**两条**会话事件（替换消息 + 测量），不调用模型；
- 读取 profile 补丁、会话记录与 token meter；
- `/context-tune preset` 与 `/context-tune rescue` 会写 **profile 补丁**（写前备份为 `<patch>.bak-trim-preset`）；
- 自动路径只在 profile 平面可达时写入；不可达时只**报告**，不静默失败。

## 边界

- **它是丢弃内容，不是摘要。** 被裁掉的细节从模型视野里消失（仍在日志里）。想要*摘要*就用 `/compact`；两者互补
（先 `/trim` 会让之后的 `/compact` 更便宜、更可能成功）。
- **最后一条消息尽量不裁**（见 `allowTailTrim`）：保护用户指令优先于塞进预算。
- **`/trim` 不改变 preset**，preset 也不能在会话中途更换——要新参数就 **fork** 或新开会话。

## 调优压缩触发点（`/context-tune preset`）

DSH 依据 `thresholdTokens = min(contextWindow × thresholdRatio, messageBudget − headroomTokens)` 决定何时压缩，
`headroomTokens` **默认 65536**。在约 370k 以下的任何窗口上，决定触发点的是这个默认值而不是比例：131072 的路由在
**37.5 %** 就压缩，而不是 80 %。单靠比例改不动它，而 compaction 的策略是在 preset isolate realm 里**组合时**读取的，
插件无法在运行时改动它。因此 `/context-tune preset` 写的是**一个 preset**：

```yaml
# >>> dsh-command-context-trim: preset-standard (generated; delete this block to drop the preset) >>>
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    plugins:
      - id: compaction-basic
        name: '@deepseek-ai/dsh-compaction-basic'
        config:
          thresholdRatio: 0.8
          headroomTokens: 0
          modelPolicies:
            - provider: b70-sycl
              model: /models/q.gguf
              thresholdRatio: 0.8
              headroomTokens: 0
# <<< dsh-command-context-trim: preset-standard <<<
```

`inplace` 写的是**裸覆盖行**（`- id: preset-<base>` + 完整 `config:`）：补丁层**按 id 整块替换**该行的 `config`，
所以它顶掉随包 preset 的插件清单，新会话继续用**同一个 preset id**、不需要任何人去挑。代价：随包那份每次升级都会
被覆盖，而这一行会**遮蔽**它，直到你删掉这段标记块。

## 运行时重新调优（`/context-tune tune`）

在 compaction 位于 **profile 平面**的地方——任何基于 `dsh-base` 的组合，即 headless 与 tui——它的阈值就是某一行
的普通 config，cordis 通过重启 fiber 来应用 config 变更（`Fiber.update()` 解析新配置并调用 `restart()`，即 dispose
加一次全新 apply）。所以 `/context-tune tune` 是有效的：它改的是那一行。web profile 里 compaction 在会话的 preset 域内，
host 平面碰不到它——插件会**报告**这一点（`/context-tune preset` 才是那里的答案）。

## 自动化调优阈值（headless 运行）

**headless** profile 自己组合 compaction——它的树在 profile 平面上带 `compaction-basic`、`command-compact` 与
`tool-result-pruner`，而且它**从不解析会话 preset**（只有 session API、web 客户端与 `agent-preset` 行会）。
实测（干净 `DSH_HOME`）：在路由上声明 `contextWindow` 并设 `DSH_TRIM_AUTO_TUNE=1` 后，该行的
`thresholdRatio`/`headroomTokens` 与 pruner 的 `thresholdChars` 都会被写成派生值，且带 `context-trim/tuned` 记录
可审计。web 侧对应的是手动流程（见*该用哪条路线*）。

## 读会话日志

`compaction/prune` 有**两个生产者**，只有一个是本插件：本插件在就地瘦身时写入自己的记录，DSH 官方的
`tool-result-pruner` 也写同名事件。区分办法是看事件的来源与伴随字段；本插件还会写 `context-trim/tuned` 记录，
里面带有它算出的 `thresholdChars`（这也是我们验证 Bonsai 2 那次"17 → 2"的依据）。

## 开发

它放在 `fixtures/` 而不是 `test/` 下是有意的：`node --test` 会执行 `test/` 下的每个 JavaScript 文件，把服务器放在那里
会让测试挂住。

### 端到端溢出检查（不需要模型）

`fixtures/mock-overflow-server.mjs` 是一个有状态的 OpenAI 兼容端点：它强制一个比告诉 harness 的 `contextWindow`
更低的**真实**上限，并且对前 `TOOL_STEPS` 个请求回以工具调用，于是一个 turn 会不断循环、越过真实上限——这就是
上下文墙，且不需要切换模型。

### 验证状态

见英文 `README.md` 的 *Verification status* 表（149 个测试、隔离实例验证、0.3.9–0.4.4 的各项证据，以及 Bonsai 2
headless 的前后对比：`thresholdChars: 32768`、`compaction/prune` **17 → 2**）。中文版不重复该表以免两处漂移；
`test/docs-sync.test.js` 会检查本节仍然指向它。

## 许可证

MIT

---

## 计算细节

本插件算出的每个数字，以及它从哪个默认值出发。token↔字符换算用 DSH 自己的 `CHARS_PER_TOKEN = 4`
（`@deepseek-ai/dsh-token-meter`）。

### 1. 裁剪预算（`/trim` 把请求面塞进多少）

```
usable  = contextWindow − reserveOutputTokens          # reserveOutputTokens: 8192
budget  = max(1, floor(usable × targetRatio))          # targetRatio: 0.9
retain  = max(minTailTokens,                           # minTailTokens: 2048
              floor(contextWindow × retainRatio))      # retainRatio: 0.16
```

### 2. 规划器在比较什么

```
surfaceTokens  = Σ node.heuristicTokens                       # token meter 给每个请求面节点的定价
envelopeTokens = measurement.totalTokens − measurement.surfaceTokens   # 工具 schema 等固定请求数据
totalTokens    = envelopeTokens + surfaceTokens
```

### 3. 压缩触发点（自动调优与 `/context-tune preset` 写入的值）

镜像 `@deepseek-ai/dsh-compaction-basic` 的 `resolveCompactSpec`（按 dsh 0.1.7-rc.2 读取）：

```
reservedCompletion = 该路由请求的 maxTokens      # 输出预留，从 request/header 读
messageBudget      = contextWindow − reservedCompletion
headroom           = headroomTokens             # stock 65536；我们写 0
pressureBudget     = messageBudget − headroom
thresholdTokens    = floor(min(contextWindow × thresholdRatio, pressureBudget))
```

### 4. 工具结果裁剪阈值（0.3.5 起由自动调优派生）

```
prunerThresholdChars = max(8192, min(32768, 2 × (contextWindow − maxTokens)))
```

即一条工具结果最多可占该路由**消息预算的一半**，上限 32 KB、下限为 DSH 的 stock `8192`。各路由取**最小**，因此
最严格的那条说了算。

### 5. 样例

| 路由 | stock 触发点 | 调优后 | 压力触发 |
|---|---|---|---|
| Bonsai 40960 / 8192 | 无（32384 ≤ 65536）| 保持原样 | 无 |
| Bonsai 40960 / 16384 | 无（24576 ≤ 65536）| 保持原样 | 无 |
| 131072 / 16384 | 49152（37.5 %）| **104857**（80 %）| 有 |
| 1000000 / 256000 | 678464（67.8 %）| **744000**（74.4 %）| 有 |

### 6. 自动裁剪

`autoTrim: true` 通过缩小预算来重试失败的请求：
`nextCeiling = max(1, floor(failingTotal × (1 − autoTrimShrink)))`，`autoTrimShrink: 0.5`，最多
`maxAutoTrimRetries: 3` 次，之后放弃并报告它测到的东西。
