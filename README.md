# cf-agent-memory

**Personal agent memory that lives on Cloudflare's free tier.**
一个跑在 Cloudflare 免费额度上的个人 Agent 长期记忆服务：MCP 协议接入，语义 + 关键词混合召回，零服务器、零数据库运维。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xxynly/cf-agent-memory)

```
Claude Code / Cursor / CodeBuddy / 任何 MCP 客户端
                 │  MCP over HTTP
                 ▼
        ┌────────────────────┐
        │  Worker (Hono)     │  鉴权 · 限流 · 路由
        └───┬────────┬───────┘
            │        │
     ┌──────▼──┐  ┌──▼─────────┐
     │   D1    │  │ Vectorize  │   ← 原文 / 全文索引 / 语义索引
     │  SQLite │  │  1024 维    │
     └────┬────┘  └──┬─────────┘
          └────┬─────┘
               ▼
        RRF 融合 + 时间加权  →  top-k 记忆
```

---

## 为什么做这个

市面上的 Agent 记忆方案大多要求你跑一个 Python 服务、维护一个向量库，或者接受 SaaS 的数据托管。个人用其实只需要三件事：

1. **记住**值得长期保留的事实、偏好、决策；
2. **召回**时不靠模型自觉，而是给一个稳定的检索接口；
3. **不花钱、不运维**。

这个项目把这三件事压进一个 Worker：D1 存原文与全文索引，Vectorize 存语义向量，Workers AI 提供 embedding，全部在 Cloudflare 免费额度内。

## 特性

- **MCP 原生**：12 个工具（记忆 6 + 技能 6），Claude Code、Cursor、CodeBuddy 等直接接入
- **混合召回**：语义（Vectorize）+ 关键词（FTS5 + 中文 bigram）+ RRF 融合 + 时间加权，任一路失败自动降级
- **同键覆盖**：`key='project.database'` 写入新值自动 supersede 旧值，不会积累互相矛盾的记忆
- **技能库**：SKILL.md 托管 + 版本快照 + R2 资源文件 + 按 agent 分配，同名再导入自动升版本
- **分层字段**：`l0/l1/l2/l3` + `fact/event/instruction/task`，为后续的自动提炼留好结构
- **REST API**：与 MCP 工具一一对应，方便脚本、Web UI、自定义客户端
- **自带面板**：单页 Web UI，记忆与技能两个标签页
- **限流**：每个用户一个 Durable Object 做固定窗口限流，跨边缘强一致
- **一键部署**：`npm run setup && npm run deploy`，自动创建 D1 / Vectorize / R2 / secret

## 快速开始

### 方式一：一键部署（推荐）

点击顶部 **Deploy to Cloudflare** 按钮。Cloudflare 会克隆仓库到你自己的账号，自动创建 D1、Vectorize 索引和 Durable Object，回填 `database_id`，并在部署时执行 `schema.sql` 建表。唯一需要你填的是 `ADMIN_TOKEN`：

```bash
openssl rand -hex 32     # 生成一个，粘到部署页面
```

也可以在本地部署：

```bash
git clone https://github.com/xxynly/cf-agent-memory.git
cd cf-agent-memory
npm install
npx wrangler login     # 只需一次
npm run setup          # 创建 D1 + Vectorize + 表结构 + ADMIN_TOKEN
npm run deploy         # 建表（幂等）后发布 Worker
```

`npm run setup` 会打印 `ADMIN_TOKEN`，并写入 `.dev.vars`（已 gitignore）；它也可重复执行，已存在的资源会跳过。

### 方式二：本地调试

```bash
npm run setup
npm run dev     # http://localhost:8787
```

本地调试同样需要远程 D1/Vectorize（`--experimental-vectorize-bind-to-prod` 已在 `dev` 脚本外说明，见 docs/deploy.md）。

## 接入 MCP 客户端

把 `<WORKER_URL>` 和 `<TOKEN>` 换成部署输出与 `npm run setup` 打印的值。

**Claude Code**（`~/.claude.json` 或项目 `.mcp.json`）：

```json
{
  "mcpServers": {
    "memory": {
      "type": "http",
      "url": "https://<WORKER_URL>/mcp",
      "headers": {
        "Authorization": "Bearer <TOKEN>",
        "X-User-Id": "personal"
      }
    }
  }
}
```

**Cursor / CodeBuddy / 其他 MCP 客户端**：同样填 HTTP 类型的 URL 与两个 header。

接好之后，让 Agent「记住这个」，它会调用 `memory_remember`；下次新会话问「我们之前定的数据库是什么」，会走 `memory_recall`。

## 工具一览

**记忆**

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `memory_remember` | 写入一条记忆 | `content`、`key?`、`kind?`、`layer?`、`tags?`、`importance?` |
| `memory_recall` | 混合召回 | `query`、`limit?` |
| `memory_list` | 按时间倒序列出 | `limit?`、`offset?`、`layer?`、`kind?`、`tag?` |
| `memory_update` | 原地修正 | `id`、`content?`、`tags?`、`importance?` |
| `memory_forget` | 删除 | `id` |
| `memory_stats` | 按层/类型统计 | — |

**技能**

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `skill_import` | 导入/更新 SKILL.md（同名升版本） | `name`、`content`、`description?`、`tags?` |
| `skill_list` | 列出技能库 | `limit?`、`offset?`、`tag?`、`agent_id?` |
| `skill_get` | 取全文，可钉住版本 | `name`、`version?` |
| `skill_search` | 关键词检索技能 | `query`、`limit?` |
| `skill_allocate` | 分配给某个 agent | `name`、`agent_id` |
| `skill_delete` | 删除技能及其文件 | `name` |

REST 接口与之一一对应，见 [docs/api.md](docs/api.md)。

## 召回是怎么工作的

```
query ──┬─► Workers AI embedding ──► Vectorize top-20 ─┐
        │                                              ├─► RRF(k=60) ─► 时间加权 ─► top-k
        └─► 分词（latin 词 + 中文 bigram）──► FTS5 top-20 ┘
```

- 写入和查询用**同一个分词函数**，避免两边 token 不一致导致召回静默失效
- RRF 不需要两路分数可比，天然适合语义 + 关键词融合
- 时间加权只在相关度接近时起作用（半衰期 30 天，权重 0.15）
- Vectorize 或 embedding 挂掉时自动降级为纯关键词，接口不报错

## 免费额度够用吗

| 资源 | 免费额度 | 个人用量 | 结论 |
|---|---|---|---|
| Workers | 10 万请求/天 | 每天几百次 | 富余 |
| D1 | 5GB / 10 万行写/天 | 每年几万条记忆 | 富余 |
| Vectorize | 500 万存储维度 ≈ 4900 条（1024 维） | 个人 1~3 年 | 够用，超了见下 |
| Workers AI | 1 万 Neurons/天 | embedding 消耗很低 | 富余 |
| R2 | 10GB / A 类 100 万次写/月 | 技能资源文件 | 富余 |
| Durable Objects | 10 万请求/天 | 只做限流 | 富余 |

**Vectorize 装不下之后**（约 4900 条）：把 embedding 换成 384 维模型（免费额度约 1.3 万条），或只对 `l2/l3` 建向量、`l1` 只走关键词。取舍见 [docs/architecture.md](docs/architecture.md#向量容量)。

## 已知限制

- **Vectorize 写入有最终一致性**：新记忆通常几秒到 1 分钟内可被语义召回命中，关键词召回立即可用
- **MCP 是无状态的**：每次请求独立，不维护会话；记忆状态都在 D1 里
- **单用户模型**：用 `X-User-Id` 区分，但没有多租户 ACL。多人共用请自行加一层网关
- **中文分词用 bigram**：对短句足够，长文档的召回质量不如专业分词器

## 开发

```bash
npm run typecheck
npm test
npm run dev
npm run tail      # 线上日志
```

目录结构：

```
src/
├── index.ts          # Hono 路由 + MCP 挂载
├── mcp.ts            # 6 个 MCP 工具
├── auth.ts           # Bearer 鉴权 + DO 限流
├── memory/
│   ├── store.ts      # D1 读写 + FTS5
│   ├── vector.ts     # Workers AI embedding + Vectorize
│   ├── recall.ts     # 混合召回
│   └── ingest.ts     # 批量写入
├── do/user-memory.ts # 每用户限流
└── lib/              # 分词 / RRF / id
```

## 路线图

- [ ] 对话批量摄入 + 可选 LLM 提炼（L0 → L1）
- [ ] 自动去重与冲突检测（除了 key 覆盖之外的语义重复）
- [ ] 记忆导出 / 导入（JSON）
- [ ] 定时归档：冷数据转 R2，只保留摘要向量
- [ ] 多用户 ACL 与共享空间

## 与同类项目的区别

| | 本项目 | mcp-memory | TencentDB Agent Memory |
|---|---|---|---|
| 部署 | 一键，CF 免费层 | 一键，CF 免费层 | Docker 三件套 |
| 记忆结构 | 分层字段 + 同键覆盖 | 平铺文本 | L0–L3 完整提炼 |
| 召回 | 语义 + 关键词 + RRF | 纯语义 | BM25 + 向量 + RRF |
| Skill / Wiki / CodeGraph | 无 | 无 | 有 |
| 面板 | 简单列表页 | 简单列表页 | 完整 Hub |

本项目的定位是「个人用、够用、可维护」：不做团队资产化，但把记忆的写入、覆盖、召回做扎实。

## License

[MIT](LICENSE)
