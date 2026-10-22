# 代理注入（Proxy Injection）代价测算

> 问题：原项目 TencentDB Agent Memory 的「自动记忆」靠 MemoryProxy 转发 LLM 流量并注入上下文。
> 本项目要不要在 Cloudflare 上重做这条链路？代价多少？
>
> 结论先行：**值得做，但只做最小版**。原项目这条链路约 2 万行，个人版压到 **650~900 行 / 3~5 天**；
> 关键约束不是功能，而是 Workers 免费层 **10ms CPU/请求**。

---

## 1. 原项目的代理链路到底是什么

MemoryProxy 共 **62,619 行**。与「转发 + 注入 + 提取」直接相关的部分：

| 模块 | 行数 | 作用 |
|---|---|---|
| `pipeline/runners/` | 8,285 | 各协议的转发主流程（anthropic / openai-chat / workbuddy / codex / direct） |
| `injection/` | 6,432 | 解析 → 注入 → 序列化的管线与 8 个注入器 |
| `pipeline/stages/` | 3,162 | 30 个 stage：auth、限流、计费、会话、上游构造、流式收尾…… |
| `pipeline/strategies/` | 1,198 | agent 策略 423 + 协议策略 775 |
| `agent-adapters/` | 789 | 8 个 agent 的适配（claude-code / codebuddy / codex / opencode / workbuddy / pi / dsh / default） |
| `decision/` | 460 | 是否注入的决策 |
| `server.ts` | 425 | 路由与启动 |
| `extraction-gate.ts` | 73 | 写入侧（提取）的总开关 |

### 注入是怎么发生的

以 `tdai-l1-recall-injector` 为例（`injection/injectors/tdai-l1-recall-injector.ts`）：

1. 取**最后一条 user 消息**作为检索 query；
2. 召回 L1 记忆（支持跨 agent 合并 + ACL 过滤）；
3. 把命中结果**插入到该轮用户消息之前**（`point = "user.before"`），每条标注来源。

也就是说：**不是改 system prompt，而是把记忆塞进当前轮次**，模型在回答时天然看得到，不需要它主动调工具。这是与 MCP 通道的本质区别。

8 个注入器分别是：L1 召回、profile 记忆、fixed-asset、技能、技能工具、知识工具、知识资产反思、通用工具。个人版只需要前两个半。

---

## 2. 在 Cloudflare 上：哪些要重写，哪些直接砍

### 直接砍（个人版不需要，或技术上不可行）

| 原项目部分 | 行数 | 砍掉理由 |
|---|---|---|
| `runners/workbuddy.ts`、`runners/openai-chat.ts`、`runners/codex.ts` | ~5,300 | 先只支持 Anthropic 兼容协议，一家覆盖 Claude Code / CodeBuddy / WorkBuddy |
| `injection/agents/`（4 个 agent profile） | 1,735 | 注入发生在**协议层**，与具体 agent 无关；原项目拆开是为了 team/ACL/资产差异 |
| `strategies/agent/` | 423 | 同上 |
| 计费（credit / pricing / credit-reporter / accessKeys） | — | 个人单用户无计费 |
| 遥测（clickhouse / langfuse / opik / trace-archive / requestLog） | — | 用 `wrangler tail` 足够 |
| 存储（COS / redis-session-store） | — | D1 + DO 已覆盖 |
| `magika`（文件类型识别） | — | 原生模块，Workers 不可用 |

### 要重写的

| 需要的能力 | 原项目参照 | 本项目现状 | 预估新增 |
|---|---|---|---|
| 代理路由：收包 → 注入 → 转发 → 流式回传 | `runners/anthropic.ts` + `stages/forward*.ts` | 无 | ~250 行 |
| 注入内容构造（记忆召回 + 技能列表） | `tdai-l1-recall-injector` + `skill-injector` | `recall()` / `skill_search()` **已实现** | ~150 行 |
| OpenAI 兼容协议（可选，给 Codex/Cursor） | `adapters/openai.ts` | 无 | ~150 行 |
| 响应侧提取（tee 流，把对话写回记忆） | `extraction-gate` + recorder | `ingest()` **已实现** | ~200 行，**有 CPU 风险** |
| 配置与开关（启用哪个注入器、上限） | `config.ts` | 无 | ~100 行 |

**最小版（v1）合计约 650~900 行**；含 OpenAI 协议与响应提取约 1,200 行。

---

## 3. Cloudflare 平台的真实约束

已核对官方 limits 文档：

| 约束 | 免费层数值 | 对代理的影响 |
|---|---|---|
| HTTP 请求时长 | **无硬限制**（客户端不断开就能一直流式） | ✅ LLM 长流式响应没问题 |
| **CPU 时间/请求** | **10 ms** | ⚠️ **唯一的硬风险**，见下 |
| 子请求/请求 | 50 | ✅ 上游 1 次 + embedding/D1 各 1 次，富余 |
| `waitUntil` | 30 秒 | ✅ 后台提取够用 |

### 10ms CPU 预算怎么花

Claude Code 一个会话的请求体很容易到 **200KB~1MB**（含历史消息和 tool_result）。一次注入要：

- `JSON.parse(body)`：约 1ms / 100KB
- 改 `system` 或 messages 后 `JSON.stringify`：与上面同量级
- 拼接注入文本：可忽略

也就是说**仅解析 + 重新序列化就可能吃掉 2~10ms**，长会话下会超预算直接报错。

**对策（按优先级）**：

1. **体量闸门**：body 超过 512KB 时跳过注入、原样转发。宁可这轮不注入，也不能让请求失败。
2. **只动一个字段**：注入点固定为 system 末尾追加一个 text block，避免深拷贝整个 messages 数组（`JSON.parse` 后只改 `body.system`，再 `JSON.stringify` 仍是全量——无法避免，所以对策 1 是关键）。
3. **首轮才注入**：检测 system 里是否已有本项目注入的标记块，有则跳过。省掉重复注入的字符串拼接，但省不掉 parse/stringify。
4. **响应侧 tee 提取延后做**：解析 SSE 的 CPU 成本与响应长度成正比，风险比请求侧更高。v1 先不做，提取继续由 agent 调 `memory_remember` 完成。

### 另一个必须说清楚的点：API Key

代理需要把客户端的 Anthropic Key 透传到上游，意味着 **Worker 能看到你的 LLM Key**。原项目是自托管，同样看得到，但 CF 上是公网服务。所以代理路由必须满足：

- 独立 token（不复用 MCP 的 `ADMIN_TOKEN`，或至少单独开一个 `PROXY_TOKEN`）；
- 只允许转发到配置好的上游域名，禁止任意 URL，避免被当成开放代理滥用；
- 限流走已有的 DO 限流器。

---

## 4. 三档方案

| 方案 | 内容 | 代码量 | 工期 | 风险 |
|---|---|---|---|---|
| **A. 最小可用** | Anthropic 兼容协议 + L1 召回注入 + 技能列表注入 + 体量闸门 + 独立 token | 650~900 行 | 3~5 天 | 低 |
| **B. A + OpenAI 协议** | 再支持 Codex / Cursor 等 OpenAI 兼容客户端 | +150 行 | +1~2 天 | 低 |
| **C. B + 响应提取** | tee 响应流，把对话自动写回记忆（真正的全自动） | +200 行 | +2 天 | **中高**（CPU 超限） |

原项目的完整体验对应 C，但 C 的收益最小、风险最大——因为提取已经有 MCP 通道（agent 主动 `memory_remember`）和 `/v1/ingest` 兜底。

---

## 5. 建议

**做 A，不做 C。**

理由：

- A 用 3~5 天换来「配一次 base_url 就自动有记忆」，和原项目用法对齐，且不依赖模型自觉；
- 注入是**纯增益**：闸门触发时原样转发，最坏情况就是这轮没注入，不会让请求失败；
- C 的自动提取在 10ms CPU 预算下不可靠，而 MCP 通道已经覆盖了这个需求，属于重复建设；
- B 看你用不用 Codex/Cursor，需要再加。

**落地后本项目就有两条通道**：MCP（模型自觉、精确控制）+ 代理（自动、零配置）。原项目正是这个双通道形态。
