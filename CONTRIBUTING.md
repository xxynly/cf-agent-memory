# 贡献

## 开发环境

```bash
npm install
npm run typecheck
npm test
npm run dev
```

## 提交前

- `npm run typecheck` 必须通过
- `npm test` 必须通过
- 涉及召回逻辑的改动，请在 PR 描述里附一个前后对比（用同一段中文 + 英文查询）

## 代码约定

- 所有存储访问走 `src/memory/store.ts`，不要在路由里写 SQL
- 新增召回通道必须经过 RRF 融合，不允许直接拼分数
- 任何外部依赖（Vectorize / Workers AI / DO）都必须有降级路径，接口不能因此 500
- 写入和查询共用 `src/lib/tokens.ts` 的分词函数

## 提交信息

```
feat: 增加语义去重
fix: 修复同键覆盖时 FTS 未清理
docs: 补充向量容量说明
```
