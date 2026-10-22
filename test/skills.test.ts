import { describe, expect, it } from "vitest";
import { safePath } from "../src/skills/store.js";

/**
 * Resource files are addressed by relative path inside the R2 prefix. Anything
 * that could escape the prefix must be rejected outright, otherwise one skill
 * could reach another user's bytes.
 */
describe("safePath", () => {
  it("accepts ordinary nested paths", () => {
    expect(safePath("SKILL.md")).toBe("SKILL.md");
    expect(safePath("/scripts/deploy.sh")).toBe("scripts/deploy.sh");
    expect(safePath("references/deep/nested.md")).toBe("references/deep/nested.md");
  });

  it("trims surrounding whitespace", () => {
    expect(safePath("  SKILL.md  ")).toBe("SKILL.md");
  });

  it("rejects traversal", () => {
    expect(safePath("../other-skill/SKILL.md")).toBeNull();
    expect(safePath("scripts/../../etc/passwd")).toBeNull();
    expect(safePath("..")).toBeNull();
    expect(safePath("..\\windows")).toBeNull();
  });

  it("rejects empty and overlong paths", () => {
    expect(safePath("")).toBeNull();
    expect(safePath("/")).toBeNull();
    expect(safePath("   ")).toBeNull();
    expect(safePath("a".repeat(513))).toBeNull();
  });

  it("accepts a path exactly at the length cap", () => {
    expect(safePath("a".repeat(512))).toBe("a".repeat(512));
  });
});
