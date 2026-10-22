# 部署

## 前置

- Node.js ≥ 20
- Cloudflare 账号（免费版即可）
- 本地执行过 `npx wrangler login`

## 一键脚本

```bash
npm install
npm run setup
npm run deploy
```

`setup` 依次做四件事，全部幂等，可以重复执行：

| 步骤 | 命令 | 说明 |
|---|---|---|
| 1 | `wrangler d1 create cf-agent-memory` | 已存在则复用，把 `database_id` 写回 `wrangler.jsonc` |
| 2 | `wrangler vectorize create cf-agent-memory --dimensions=1024 --metric=cosine` | 已存在则跳过 |
| 3 | `wrangler d1 execute --remote --file=./schema.sql` | 建表 + FTS5 虚表 |
| 4 | `wrangler secret put ADMIN_TOKEN` | 没有则生成并写入 `.dev.vars` |

部署完成后会打印 `https://cf-agent-memory.<你的子域>.workers.dev`。

## 手动部署

如果脚本在某一步失败，按下面顺序手工执行：

```bash
npx wrangler login

npx wrangler d1 create cf-agent-memory
# 把输出的 database_id 填进 wrangler.jsonc

npx wrangler vectorize create cf-agent-memory --dimensions=1024 --metric=cosine

npx wrangler d1 execute cf-agent-memory --remote --file=./schema.sql

npx wrangler secret put ADMIN_TOKEN
# 粘贴一个随机串，例如 openssl rand -base64 24

npx wrangler deploy
```

## Deploy to Cloudflare 按钮

按钮会克隆仓库并创建 Worker，但 **D1 与 Vectorize 不一定能自动创建**。部署完成后仍建议本地执行一次 `npm run setup`，它会检测已存在的资源并补齐缺失的部分。

## 本地开发

```bash
npm run dev
```

注意两点：

- **D1 可以本地模拟**，但 `schema.sql` 需要先应用到本地库：`npm run db:local`
- **Vectorize 没有本地模拟**，本地调试时向量查询会失败并自动降级为关键词召回。要测完整链路请直接部署到线上，或在 `wrangler dev` 时加 `--experimental-vectorize-bind-to-prod`（会写生产索引）

## 绑定自定义域名

`wrangler.jsonc` 加：

```jsonc
"routes": [{ "pattern": "memory.example.com", "custom_domain": true }]
```

然后 `npm run deploy`。域名需已托管在同一个 Cloudflare 账号下。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `EMBEDDING_MODEL` | `@cf/baai/bge-m3` | 换模型必须同时重建 Vectorize 索引 |
| `VECTOR_DIMENSIONS` | `1024` | 仅用于文档说明，实际维度由索引决定 |
| `RATE_LIMIT_PER_MINUTE` | `120` | 每用户每分钟写操作上限 |

改 `wrangler.jsonc` 的 `vars` 后重新 `npm run deploy`。

## 更新表结构

`schema.sql` 全部使用 `IF NOT EXISTS`，新增表/索引直接重跑：

```bash
npx wrangler d1 execute cf-agent-memory --remote --file=./schema.sql
```

已有表加字段需要手写 `ALTER TABLE`（D1 支持 `ADD COLUMN`，不支持改类型）。

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| `401 unauthorized` | token 不匹配 | 检查 `Authorization: Bearer`，或重新 `wrangler secret put ADMIN_TOKEN` |
| 部署报 `REPLACE_WITH_D1_ID` | 没跑 setup | 跑 `npm run setup` 或手填 `database_id` |
| 召回 `vector: 0` 但 `degraded: []` | Vectorize 最终一致性 | 等 1 分钟再试；写入时看 `vectorIndexed` |
| `diagnostics.degraded` 出现 `vector:...` | embedding 或索引异常 | 看 `npm run tail` 的日志；确认模型名与索引维度一致 |
| 关键词召回 0 且 `keyword:...` | FTS5 表缺失 | 重跑 schema；代码会自动退化为 LIKE |
| `429 rate_limited` | 触发每分钟上限 | 调大 `RATE_LIMIT_PER_MINUTE`，或等 60 秒 |
| `Vectorize dimension mismatch` | 索引维度与模型不符 | 删索引重建：`wrangler vectorize delete cf-agent-memory` 后重跑 setup |
| Workers AI 报配额 | 免费 1 万 Neurons/天 | 次日恢复；或换更小的 embedding 模型 |

看线上日志：

```bash
npm run tail
```
