# API

Base URL：`https://<WORKER_URL>`
鉴权：`Authorization: Bearer <ADMIN_TOKEN>`（所有 `/v1/*` 与 `/mcp`）
用户：`X-User-Id: <id>`（可选，默认 `personal`）

---

## 健康检查

```bash
curl https://<WORKER_URL>/health
```

```json
{ "ok": true, "service": "cf-agent-memory", "version": "0.1.0", "time": "..." }
```

---

## 写入一条记忆

`POST /v1/memories`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `content` | string | ✅ | 自包含的一句话，避免指代 |
| `key` | string | | 主题键，同键新值会 supersede 旧值 |
| `layer` | `l0`\|`l1`\|`l2`\|`l3` | | 默认 `l1` |
| `kind` | `fact`\|`event`\|`instruction`\|`task` | | 默认 `fact` |
| `tags` | string[] | | 最多 20 个 |
| `scope` | string | | 默认 `personal` |
| `importance` | 1–5 | | 默认 3 |
| `source` | string | | 来源标记，如会话 id |

```bash
curl -X POST https://<WORKER_URL>/v1/memories \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "这个项目用 PostgreSQL 17，端口 8080。",
    "key": "project.database",
    "tags": ["infra"],
    "importance": 5
  }'
```

```json
{ "ok": true, "memory": { "id": "mem_...", "...": "..." }, "vectorIndexed": true }
```

`vectorIndexed: false` 表示向量索引没写成功，记忆本身已落库，关键词召回仍可用。

---

## 混合召回

`POST /v1/recall`

```bash
curl -X POST https://<WORKER_URL>/v1/recall \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "数据库用什么？", "limit": 5}'
```

```json
{
  "ok": true,
  "hits": [
    {
      "memory": { "id": "mem_...", "content": "这个项目用 PostgreSQL 17，端口 8080。", "...": "..." },
      "score": 0.0188,
      "via": ["vector", "keyword"]
    }
  ],
  "diagnostics": { "vector": 1, "keyword": 1, "fused": 2, "degraded": [] }
}
```

`via` 说明这一条被哪一路命中；`diagnostics.degraded` 非空时表示有通道降级（例如 `vector:...`）。

---

## 列表

`GET /v1/memories?limit=20&offset=0&layer=l1&kind=fact&tag=infra&includeSuperseded=0`

默认只返回未被覆盖的记忆。

## 单条

`GET /v1/memories/:id` → 404 表示不存在或不属于该用户。

## 修改

`PATCH /v1/memories/:id`

```json
{ "content": "改为 PostgreSQL 17", "tags": ["infra"], "importance": 5, "key": "project.database" }
```

## 删除

`DELETE /v1/memories/:id` —— 同时删除 D1 行、FTS 行与向量。

## 批量写入

`POST /v1/ingest`

```json
{
  "source": "session-2026-10-22",
  "items": [
    { "content": "...", "tags": ["..."] },
    { "content": "...", "key": "..." }
  ]
}
```

单次最多 **20 条**（受 Workers 子请求预算限制）。整批共用一次 embedding 调用与一次 Vectorize upsert。

## 统计

`GET /v1/stats` → `{ total, byLayer, byKind, skills: { total, allocations } }`

---

# 技能

技能 = 一份 SKILL.md（`skills` 表，head 版本）+ 可选资源文件（R2）。`POST /v1/skills` 对同名技能执行**更新**：旧 head 快照进 `skill_versions`，版本号 +1，可回滚。

## 导入 / 更新

```bash
curl -X POST https://<WORKER_URL>/v1/skills \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"cf-deploy-runbook","description":"部署流程","tags":["deploy"],
       "content":"# CF Deploy Runbook\n\n## 步骤\n1. npm run typecheck\n2. npm run deploy"}'
```

→ `{ ok, created, previousVersion, skill }`。`created=false` 表示是更新。

## 列表 / 检索

```bash
curl "https://<WORKER_URL>/v1/skills?limit=20&tag=deploy" -H "Authorization: Bearer $TOKEN"
curl "https://<WORKER_URL>/v1/skills?q=部署" -H "Authorization: Bearer $TOKEN"        # 关键词
curl "https://<WORKER_URL>/v1/skills?agent=claude-code" -H "Authorization: Bearer $TOKEN"
```

列表响应不含 SKILL.md 全文（只有 `contentChars` 与 200 字 `excerpt`），全文走 `GET /v1/skills/:name`。

`:name` 可以是技能名，也可以是 `skl_` 开头的 id。

## 详情 / 修改 / 删除

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/v1/skills/:name` | 全文 + `manifest` + `allocations` |
| `PATCH` | `/v1/skills/:name` | 改 `description` / `tags` / `status` / `owner_agent_id`（改内容请重新导入） |
| `DELETE` | `/v1/skills/:name` | 删除技能、版本、分配与 R2 文件 |
| `GET` | `/v1/skills/:name/versions` | 版本历史（head + 快照） |
| `GET` | `/v1/skills/:name/versions/:version` | 取某一版本原文 |

## 资源文件（R2）

```bash
# 上传
curl -X PUT "https://<WORKER_URL>/v1/skills/cf-deploy-runbook/files/scripts/deploy.sh" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/x-shellscript" \
  --data-binary '#!/bin/bash
npm run deploy'

# 读取 / 列表 / 删除
curl "https://<WORKER_URL>/v1/skills/cf-deploy-runbook/files/scripts/deploy.sh" -H "Authorization: Bearer $TOKEN"
curl "https://<WORKER_URL>/v1/skills/cf-deploy-runbook/files" -H "Authorization: Bearer $TOKEN"
curl -X DELETE "https://<WORKER_URL>/v1/skills/cf-deploy-runbook/files/scripts/deploy.sh" -H "Authorization: Bearer $TOKEN"
```

路径必须相对，拒绝 `..`；单文件上限 **2MB**。文件改动后 `manifest` 自动刷新。

## 分配

```bash
curl -X POST https://<WORKER_URL>/v1/skills/cf-deploy-runbook/allocate \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"agent_id":"claude-code"}'

curl -X DELETE https://<WORKER_URL>/v1/skills/cf-deploy-runbook/allocate/claude-code \
  -H "Authorization: Bearer $TOKEN"
```

个人版没有 agent 注册表，`agent_id` 只是标签，用于 `skill_list?agent=` 过滤。

---

# MCP

Endpoint：`POST /mcp`，Streamable HTTP，无状态。

## 握手

```bash
curl -X POST https://<WORKER_URL>/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

## 工具

| 名称 | 入参 |
|---|---|
| `memory_remember` | `content`、`key?`、`kind?`、`layer?`、`tags?`、`importance?` |
| `memory_recall` | `query`、`limit?` |
| `memory_list` | `limit?`、`offset?`、`layer?`、`kind?`、`tag?` |
| `memory_update` | `id`、`content?`、`tags?`、`importance?` |
| `memory_forget` | `id` |
| `memory_stats` | — |
| `skill_import` | `name`、`content`、`description?`、`tags?` |
| `skill_list` | `limit?`、`offset?`、`tag?`、`agent_id?` |
| `skill_get` | `name`、`version?` |
| `skill_search` | `query`、`limit?` |
| `skill_allocate` | `name`、`agent_id` |
| `skill_delete` | `name` |

调用示例：

```bash
curl -X POST https://<WORKER_URL>/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"memory_recall","arguments":{"query":"数据库端口","limit":3}}}'
```

---

# 错误

| 状态码 | body | 含义 |
|---|---|---|
| 400 | `invalid_body` + `details` | 参数校验失败 |
| 401 | `unauthorized` | token 缺失或不匹配 |
| 404 | `not_found` | id 不存在 |
| 413 | `file_too_large` | 技能资源文件超过 2MB |
| 429 | `rate_limited` | 超出每分钟限制，`Retry-After: 60` |
| 500 | `internal_error` | 未捕获异常，看 `wrangler tail` |
