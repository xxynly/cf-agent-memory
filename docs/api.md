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

`GET /v1/stats` → `{ total, byLayer, byKind }`

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
| 429 | `rate_limited` | 超出每分钟限制，`Retry-After: 60` |
| 500 | `internal_error` | 未捕获异常，看 `wrangler tail` |
