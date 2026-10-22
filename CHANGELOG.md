# Changelog

## 0.3.2 — 2026-10-22

修复面板标签页：记忆与技能出现在同一页。

- 原因：`main { display: grid }` 覆盖了 `hidden` 属性自带的 `display: none`——作者样式永远胜过 UA 默认样式，于是技能视图一直和记忆视图并排显示，且因为 `loadSkills()` 只在点击标签时触发，技能区在记忆页上永远停在「加载中…」
- 修复：新增 `[hidden] { display: none !important; }`
- `test/panel.test.ts` 增加视图切换契约断言（含上述 CSS 优先级陷阱）
- 本地用无头 Chrome 实测：记忆页只显示记忆、切到技能页只显示技能且正常加载、切回正常；上一个 tags bug 未回归

## 0.3.1 — 2026-10-22

修复 Web UI 记忆列表报错 `(item.tags || []).map is not a function`。

- 原因：D1 的 `tags` 是逗号分隔字符串（`infra,decision`），面板却按数组渲染
- 修复：新增 `toTags()` 归一化，同时兼容字符串与数组两种形状；记忆与技能两个渲染路径都改用
- 新增 `test/panel.test.ts`：静态断言面板不再假设 `item.tags` 是数组（面板是无构建步骤的单文件 HTML，运行时错误在浏览器里才会暴露，故用测试钉住契约）

## 0.3.0 — 2026-10-22

LLM 代理注入（方案 A）。

- `POST /v1/messages` 转发到 Anthropic 兼容上游，流式响应原样回传
- 注入：拿最后一条**含文字**的用户消息当 query，召回 top-5 记忆 + 列出技能，插到该轮之前；不动 `system`，不碰纯 `tool_result` 轮
- 体量闸门：body 超过 `MAX_PROXY_BODY_BYTES`（默认 512KB）跳过注入原样转发——免费层 10ms CPU/请求，长会话解析就可能超预算
- 注入文本硬上限 `INJECTION_BUDGET_CHARS`（默认 4000），每条记忆截断到 300 字符
- 独立 `PROXY_TOKEN` 鉴权；未配置返回 503，其他接口不受影响
- 客户端 `x-api-key` 优先，否则用 Worker 上的 `ANTHROPIC_API_KEY`；客户端 `authorization` 不透传
- 可观测头：`x-cfam-injected` / `x-cfam-reason` / `x-cfam-upstream-ms`
- 降级：注入任何环节失败都原样转发，绝不把请求搞失败
- 15 个新单元测试（提取/定位/配置/降级），全部 35 个测试通过

## 0.2.0 — 2026-10-22

技能库（Skills）。

- 6 个 MCP 工具：`skill_import` / `skill_list` / `skill_get` / `skill_search` / `skill_allocate` / `skill_delete`
- REST：`/v1/skills` CRUD、`/v1/skills/:name/files/*`、`/v1/skills/:name/versions`、`/v1/skills/:name/allocate`
- 版本模型：同名再导入 → 旧 head 快照进 `skill_versions`，版本号 +1，可回滚
- 资源文件存 R2（`<user>/skills/<id>/<path>`），`manifest` 自动刷新；单文件上限 2MB
- 关键词检索走 D1 FTS5，与记忆召回共用同一分词函数
- `npm run setup` 增加 R2 桶创建；一键部署按钮可自动分配 R2
- Web UI 新增「技能」标签页：导入、搜索、查看全文、删除

## 0.1.0 — 2026-10-22

首个可用版本。

- MCP over Streamable HTTP（无状态），6 个工具：`memory_remember` / `memory_recall` / `memory_list` / `memory_update` / `memory_forget` / `memory_stats`
- REST API：`/v1/memories` CRUD、`/v1/recall`、`/v1/ingest`、`/v1/stats`、`/health`
- 混合召回：Workers AI embedding + Vectorize 语义通道，FTS5 + 中文 bigram 关键词通道，RRF 融合 + 时间加权
- 同键覆盖：`key` 相同的新记忆自动 supersede 旧记忆，召回默认过滤失效项
- 降级：embedding / Vectorize / FTS5 / DO 任一不可用都不阻塞请求
- 每用户 Durable Object 限流（默认 120 次/分钟）
- 单页 Web UI：搜索、新增、删除、统计
- 一键脚本：自动创建 D1、Vectorize、应用 schema、写入 ADMIN_TOKEN
- 单元测试：分词、FTS 查询构造、RRF、时间衰减
