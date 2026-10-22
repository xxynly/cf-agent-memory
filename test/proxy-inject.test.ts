import { describe, expect, it } from "vitest";
import {
  INJECTION_MARKER,
  buildInjection,
  extractLastUserText,
  injectIntoBody,
  readInjectionConfig,
} from "../src/proxy/inject.js";
import type { Env } from "../src/types.js";

const BLOCK = `${INJECTION_MARKER}\n## 长期记忆\n- 项目用 PostgreSQL 16`;

describe("extractLastUserText", () => {
  it("reads a plain string content", () => {
    expect(extractLastUserText({ messages: [{ role: "user", content: "数据库端口是多少" }] })).toBe(
      "数据库端口是多少",
    );
  });

  it("concatenates text blocks", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "第一段" },
            { type: "image", source: {} },
            { type: "text", text: "第二段" },
          ],
        },
      ],
    };
    expect(extractLastUserText(body)).toBe("第一段\n第二段");
  });

  it("skips a trailing tool_result turn and finds the prose turn before it", () => {
    const body = {
      messages: [
        { role: "user", content: "帮我看下数据库配置" },
        { role: "assistant", content: [{ type: "tool_use", name: "read_file" }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "port = 8080" },
          ],
        },
      ],
    };
    expect(extractLastUserText(body)).toBe("帮我看下数据库配置");
  });

  it("returns empty when there is no prose at all", () => {
    expect(
      extractLastUserText({
        messages: [
          { role: "system", content: "you are helpful" },
          { role: "user", content: [{ type: "tool_result", content: "x" }] },
        ],
      }),
    ).toBe("");
  });

  it("is defensive about malformed bodies", () => {
    expect(extractLastUserText(null)).toBe("");
    expect(extractLastUserText({})).toBe("");
    expect(extractLastUserText({ messages: "nope" })).toBe("");
    expect(extractLastUserText({ messages: [null, 42] })).toBe("");
  });
});

describe("injectIntoBody", () => {
  it("prepends the block to the last prose user turn", () => {
    const body = {
      system: "be terse",
      messages: [
        { role: "user", content: "问题一" },
        { role: "assistant", content: "回答一" },
        { role: "user", content: "问题二" },
      ],
    };
    const out = injectIntoBody(body, BLOCK);
    const last = out.messages[2] as unknown as { content: Array<{ text: string }> };
    expect(last.content[0].text).toBe(BLOCK);
    expect(last.content[1].text).toBe("问题二");
    expect(out.system).toBe("be terse");
  });

  it("does not mutate the caller's body and leaves earlier turns shared", () => {
    const first = { role: "user", content: "问题一" };
    const body = { messages: [first, { role: "user", content: "问题二" }] };
    const out = injectIntoBody(body, BLOCK);
    expect(body.messages[1]).toEqual({ role: "user", content: "问题二" });
    expect(out.messages[0]).toBe(first);
  });

  it("converts a string content into a block array", () => {
    const out = injectIntoBody({ messages: [{ role: "user", content: "原始" }] }, BLOCK);
    const last = out.messages[0] as unknown as { content: Array<{ text: string }> };
    expect(last.content.map((b) => b.text)).toEqual([BLOCK, "原始"]);
  });

  it("appends a user turn when there is none", () => {
    const out = injectIntoBody({ messages: [{ role: "assistant", content: "hi" }] }, BLOCK);
    expect(out.messages).toHaveLength(2);
    const last = out.messages[1] as unknown as { role: string; content: Array<{ text: string }> };
    expect(last.role).toBe("user");
    expect(last.content[0].text).toBe(BLOCK);
  });

  it("injects before a trailing tool_result turn, not into it", () => {
    const body = {
      messages: [
        { role: "user", content: "真正的问题" },
        { role: "user", content: [{ type: "tool_result", content: "结果" }] },
      ],
    };
    const out = injectIntoBody(body, BLOCK);
    const last = out.messages[1] as unknown as { content: Array<{ type: string }> };
    expect(last.content[0].type).toBe("tool_result");
    const first = out.messages[0] as unknown as { content: Array<{ text: string }> };
    expect(first.content[0].text).toBe(BLOCK);
  });
});

describe("readInjectionConfig", () => {
  it("defaults to both injectors on with a 4000 char budget", () => {
    expect(readInjectionConfig({} as Env)).toEqual({
      budget: 4000,
      memories: true,
      skills: true,
    });
  });

  it("honours the kill switches", () => {
    const config = readInjectionConfig({
      INJECT_MEMORIES: "0",
      INJECT_SKILLS: "0",
    } as Env);
    expect(config.memories).toBe(false);
    expect(config.skills).toBe(false);
  });

  it("clamps a nonsensical budget back to the default", () => {
    expect(readInjectionConfig({ INJECTION_BUDGET_CHARS: "abc" } as Env).budget).toBe(4000);
    expect(readInjectionConfig({ INJECTION_BUDGET_CHARS: "-5" } as Env).budget).toBe(4000);
    expect(readInjectionConfig({ INJECTION_BUDGET_CHARS: "999999" } as Env).budget).toBe(20000);
  });
});

describe("buildInjection degradation", () => {
  it("returns null rather than throwing when every store is broken", async () => {
    // A bare Env has no DB / AI / R2, so recall and listSkills both throw.
    const result = await buildInjection({} as Env, "personal", "数据库端口", {
      budget: 4000,
      memories: true,
      skills: true,
    });
    expect(result).toBeNull();
  });

  it("returns null for an empty query", async () => {
    const result = await buildInjection({} as Env, "personal", "   ", {
      budget: 4000,
      memories: true,
      skills: true,
    });
    expect(result).toBeNull();
  });
});
