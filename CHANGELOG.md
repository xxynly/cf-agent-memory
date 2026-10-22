# Changelog

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
