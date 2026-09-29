# dsh-command-context-trim

[English →](README.md) — **the English README is the canonical and maintained document.**

本文件曾经是一份完整的中文翻译，但它已**停止维护**：它跟不上 0.3.9 之后的变化（`/trim preset inplace`、
`/trim rescue`、路由覆盖率检查、fork 才是给已开始的会话换参数的正规路径、web 与 headless 的差异）。
为了不留下**看起来完整其实是错的**说明，这里只保留最短的现状摘要；细节一律以 `README.md` 为准。

## 这个插件做什么

给 DSH 增加一个**不调用任何模型**的 `/trim`：在真正溢出之前，把最旧、最不重要的上下文裁掉，让会话能用更小的
窗口继续跑；同时可以按路由调优 DSH 自己的 compaction 触发点与工具结果裁剪阈值。

## 当前命令（完整说明见 README.md）

```
/trim                                  # 手工裁剪当前会话（不调用模型）
/trim check                            # 只报告计划，不修改
/trim preset inplace                   # 把调优写进**当前 preset 自己的 id**（无需换 preset）
/trim preset check                     # 报告生成行 + 路由覆盖率（新增模型后用它判断该不该重跑）
/trim rescue <id> [--from <donor>]     # 用同 id 重建丢失的 preset，让旧会话能重新加载
```

## 三条最容易被误解的事实

1. **已开始的会话换不了 preset**（它绑在启动时组合的那个 realm 上）。要让它吃到新参数，**fork 它**：preset id
   不变，但 realm 会按**当前定义**重新组合。
2. **web profile 里自动调优不会触发**：会话的 agent 在各自的 preset 域里创建，其生命周期事件到不了 host 平面。
   web 的正确用法是手动的：`inplace` → 用 `check` 判断是否过期 → fork 或新开会话。
3. **preset id 是持久接口**：升级时请**同 id 覆盖**，不要新建 `-tuned` 后缀；否则引用旧 id 的会话会变成孤儿
   （那时用 `rescue` 救）。

调优参数的推导公式、各路由的样例值、以及完整的验证状态，见 [README.md](README.md)。
