# 架构

## 目标与约束

个人使用，三个硬约束决定了设计：

1. **零运维**：不能有常驻进程、不能自己维护向量库
2. **免费额度**：每个组件都要落在 Cloudflare Free 的限额内
3. **可降级**：任何一路检索失败，接口仍要返回结果

## 组件

| 组件 | 用途 | 为什么是它 |
|---|---|---|
| Workers | HTTP 路由、鉴权、编排 | 免费 10 万请求/天，冷启动毫秒级 |
| D1 | 记忆原文、元数据、全文索引 | SQLite 语义，FTS5 可用，5GB 免费 |
| Vectorize | 语义索引 | 托管 ANN，不用自己写索引 |
| Workers AI | embedding（`@cf/baai/bge-m3`） | 不需要外部 API key |
| Durable Objects | 每用户限流 | 跨边缘强一致，KV 做不到 |
| R2（未启用） | 冷数据归档 | 路线图里 |

## 数据模型

```sql
memories(
  id, user_id, layer, kind, key,
  content, tags, tokens,
  scope, importance, source,
  superseded_by, created_at, updated_at, accessed_at, access_count
)
memories_fts(memory_id, tokens)   -- 独立 FTS5 表，显式同步
ingest_log(id, user_id, source, count, created_at)
```

设计要点：

- **`tokens` 落库**：写入时就把分词结果算好，查询时用同一个函数，保证两侧一致
- **FTS5 独立表**：不用 external-content + trigger，UPDATE/DELETE 语义显式，避免 rowid 漂移
- **`key` + `superseded_by`**：同键新值把旧值标记为失效，而不是删除。历史仍可审计，召回默认过滤
- **`layer` / `kind`**：为将来的自动提炼预留，v0 只写 `l1/fact`

## 写入路径

```
POST /v1/memories
  → 鉴权 → DO 限流
  → 分词 → INSERT memories + INSERT memories_fts（同一 batch，事务）
  → 若带 key：UPDATE 旧行 superseded_by = 新 id
  → embedding → Vectorize upsert（namespace = user_id）
```

失败语义：

- D1 写失败 → 整个请求 500，不会出现「向量有、原文没有」
- embedding 失败 → 记忆仍然写入，`vectorIndexed: false`，关键词召回可用
- Vectorize 失败 → 同上，不阻塞

**顺序是先 D1 后向量**，因为 D1 是唯一事实来源，向量只是加速索引。

## 召回路径

```
POST /v1/recall { query, limit }
  ├─ 语义：embedding → Vectorize.query(topK=20, namespace=user)
  ├─ 关键词：tokenize → FTS5 MATCH → bm25() 排序 top-20
  └─ RRF 融合（k=60）→ 取前 3×limit → 回表 D1 → 时间加权 → top-limit
```

**为什么用 RRF**：向量分数是余弦相似度，BM25 是负值且量纲不同，直接加权需要归一化且不稳。RRF 只用排名，天然可比，是混合检索的标准做法。

**时间加权**：`score × (1 + 0.15 × 0.5^(age/30d))`。权重刻意压得很低，只在相关度接近时把新记忆顶上来，不会让旧但准确的事实沉底。

**降级链**：

| 故障 | 行为 |
|---|---|
| embedding 失败 | 纯关键词召回，`diagnostics.degraded` 记录原因 |
| Vectorize 查询失败 | 同上 |
| FTS5 不可用 | 退化为 `tokens LIKE` 三词 AND，慢但正确 |
| DO 限流不可用 | fail open，请求放行 |

## 向量容量

Vectorize 免费额度是 **500 万存储维度**：

| 维度 | 可存条数 | 适用 |
|---|---|---|
| 1024（bge-m3） | ~4900 | 个人 1~3 年 |
| 768 | ~6500 | — |
| 384 | ~13000 | 需要更长周期 |

超出后的三条路：

1. 换 384 维 embedding 模型（额度 ×2.7）
2. 只对 `l2/l3` 建向量，`l1` 只走关键词
3. 自建二值索引（见仓库外部分析文档），用 CPU 换额度

**注意**：Vectorize 写入是最终一致的，新记忆通常几秒到 1 分钟才能被语义召回命中。关键词召回没有这个延迟。测试时如果语义命中为 0，先等一分钟再试。

## 限流

每用户一个 `UserMemoryDO`，固定窗口计数存在 DO 的 storage 里：

- 跨边缘强一致（同一 DO 只有一个实例）
- 不占用 D1 的写额度
- DO 只存计数器，丢了也不影响数据

## 无状态 MCP

MCP 走 Streamable HTTP，`sessionIdGenerator: undefined`，每个请求新建 server + transport：

- 不需要维护会话，Worker 可以水平扩展到任意实例
- 记忆状态全在 D1，不依赖连接
- 代价：没有 server→client 的主动推送（记忆场景不需要）

## 将来

- L0 原始对话落库 → 异步提炼 L1（Queues + Workers AI 或外部 LLM）
- 冷数据归档到 R2，D1 只留索引与摘要
- 语义去重：写入前用向量查最近邻，相似度超阈值则合并
