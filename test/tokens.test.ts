import { describe, expect, it } from "vitest";
import { buildFtsQuery, tokenize, tokensToText } from "../src/lib/tokens.js";

describe("tokenize", () => {
  it("keeps latin words and numbers intact", () => {
    const tokens = tokenize("The server runs on port 8080 with PostgreSQL 16");
    expect(tokens).toContain("server");
    expect(tokens).toContain("8080");
    expect(tokens).toContain("postgresql");
  });

  it("emits CJK bigrams so partial phrases still match", () => {
    const tokens = tokenize("数据库用的是 PostgreSQL");
    expect(tokens).toContain("数据");
    expect(tokens).toContain("据库");
    expect(tokens).toContain("postgresql");
  });

  it("handles mixed scripts in one string", () => {
    const tokens = tokenize("部署在 Cloudflare Workers 上，端口 8096");
    expect(tokens).toContain("cloudflare");
    expect(tokens).toContain("workers");
    expect(tokens).toContain("部署");
    expect(tokens).toContain("8096");
  });

  it("drops punctuation-only input", () => {
    expect(tokenize("!!! ... ???")).toEqual([]);
  });

  it("produces identical tokens for write and query time", () => {
    const text = "用户偏好使用简体中文回复";
    expect(tokensToText(tokenize(text))).toBe(tokensToText(tokenize(text)));
  });
});

describe("buildFtsQuery", () => {
  it("quotes every token and joins with OR", () => {
    expect(buildFtsQuery(["a", "b"])).toBe('"a" OR "b"');
  });

  it("escapes embedded quotes so FTS5 cannot be injected", () => {
    expect(buildFtsQuery(['he"llo'])).toBe('"he""llo"');
  });

  it("returns empty string for no tokens", () => {
    expect(buildFtsQuery([])).toBe("");
  });
});
