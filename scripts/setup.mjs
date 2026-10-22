#!/usr/bin/env node
/**
 * One-command provisioning for cf-agent-memory.
 *
 *   npm run setup     # creates D1 + Vectorize, applies schema, sets ADMIN_TOKEN
 *   npm run deploy    # publishes the Worker
 *
 * Idempotent: safe to re-run. Existing resources are reused, the schema uses
 * CREATE ... IF NOT EXISTS, and ADMIN_TOKEN is only generated when missing.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "cf-agent-memory";
const INDEX_NAME = "cf-agent-memory";
const DIMENSIONS = "1024";

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function run(args, options = {}) {
  return execFileSync("npx", ["wrangler", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture ? ["pipe", "pipe", "pipe"] : "inherit",
    input: options.input,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
}

function tryRun(args, options = {}) {
  try {
    return { ok: true, out: run(args, { ...options, capture: true }) };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? ""}` };
  }
}

function step(text) {
  console.log(`\n${green("▸")} ${text}`);
}

step("检查 Cloudflare 登录状态");
const whoami = tryRun(["whoami"]);
if (!whoami.ok || /not authenticated|You are not logged in/i.test(whoami.out)) {
  console.error(red("未登录 Cloudflare。请先运行：npx wrangler login"));
  process.exit(1);
}
console.log(dim(whoami.out.trim().split("\n").slice(-4).join("\n")));

step(`创建 D1 数据库 ${DB_NAME}（已存在则复用）`);
const configPath = join(root, "wrangler.jsonc");
let config = readFileSync(configPath, "utf8");
let databaseId = /"database_id"\s*:\s*"([^"]+)"/.exec(config)?.[1];

if (!databaseId || databaseId === "REPLACE_WITH_D1_ID") {
  const created = tryRun(["d1", "create", DB_NAME]);
  const parsed = /database_id"?\s*[:=]\s*"([0-9a-f-]{36})"/i.exec(created.out);
  if (parsed) {
    databaseId = parsed[1];
    console.log(green(`  database_id = ${databaseId}`));
  } else if (/already exists/i.test(created.out)) {
    const list = tryRun(["d1", "list", "--json"]);
    try {
      const databases = JSON.parse(list.out);
      const found = databases.find((db) => db.name === DB_NAME);
      if (found) databaseId = found.uuid ?? found.id;
    } catch {
      /* fall through to the manual hint below */
    }
  }

  if (!databaseId) {
    console.error(red("无法自动获取 database_id。请运行 `npx wrangler d1 list` 后手动填入 wrangler.jsonc。"));
    console.error(dim(created.out.slice(-600)));
    process.exit(1);
  }

  config = config.replace(/"database_id"\s*:\s*"[^"]*"/, `"database_id": "${databaseId}"`);
  writeFileSync(configPath, config);
  console.log(green("  已写入 wrangler.jsonc"));
} else {
  console.log(dim(`  复用已有 database_id = ${databaseId}`));
}

step(`创建 Vectorize 索引 ${INDEX_NAME}（1024 维 / cosine）`);
const index = tryRun(["vectorize", "create", INDEX_NAME, `--dimensions=${DIMENSIONS}`, "--metric=cosine"]);
if (index.ok) {
  console.log(green("  已创建"));
} else if (/already exists|duplicate/i.test(index.out)) {
  console.log(dim("  已存在，跳过"));
} else {
  console.log(yellow("  创建失败，稍后请手动执行："));
  console.log(dim(`  npx wrangler vectorize create ${INDEX_NAME} --dimensions=${DIMENSIONS} --metric=cosine`));
  console.log(dim(index.out.slice(-400)));
}

step("应用数据库表结构");
const schema = tryRun(["d1", "execute", DB_NAME, "--remote", "--file=./schema.sql", "--yes"]);
if (!schema.ok) {
  console.error(red("schema 执行失败："));
  console.error(dim(schema.out.slice(-800)));
  process.exit(1);
}
console.log(green("  表结构已就绪"));

step("配置 ADMIN_TOKEN");
const devVarsPath = join(root, ".dev.vars");
let token = "";
if (existsSync(devVarsPath)) {
  token = /^ADMIN_TOKEN=(.*)$/m.exec(readFileSync(devVarsPath, "utf8"))?.[1]?.trim() ?? "";
}
if (!token) {
  token = `cfam_${randomBytes(24).toString("base64url")}`;
  writeFileSync(devVarsPath, `ADMIN_TOKEN=${token}\n`);
  console.log(green("  已生成并写入 .dev.vars（已 gitignore）"));
} else {
  console.log(dim("  复用 .dev.vars 中的 token"));
}

const secret = tryRun(["secret", "put", "ADMIN_TOKEN"], { input: `${token}\n` });
if (!secret.ok) {
  console.log(yellow("  写入 secret 失败，请手动执行："));
  console.log(dim("  npx wrangler secret put ADMIN_TOKEN"));
} else {
  console.log(green("  secret 已写入"));
}

console.log(`
${green("✓ 准备完成")}

  ADMIN_TOKEN: ${yellow(token)}

下一步：

  1. 本地调试   ${dim("npm run dev")}          ${dim("# http://localhost:8787")}
  2. 发布上线   ${dim("npm run deploy")}
  3. 部署后把 Worker URL + 上面的 token 填进面板首页

MCP 客户端（Claude Code / Cursor 等）配置：

  {
    "mcpServers": {
      "memory": {
        "type": "http",
        "url": "https://<你的-worker>.workers.dev/mcp",
        "headers": { "Authorization": "Bearer ${token}", "X-User-Id": "personal" }
      }
    }
  }
`);
