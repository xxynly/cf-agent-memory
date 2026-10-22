import panelHtml from "../public/index.html?raw";
import { describe, expect, it } from "vitest";

/**
 * The panel is a single static HTML file with no build step, so a data-shape
 * mistake in it only shows up at runtime in the browser. These tests pin the
 * contract that caused the `(item.tags || []).map is not a function` bug:
 * D1 returns tags as a comma-joined string, not an array.
 */
describe("panel tag handling", () => {
  it("normalises tags through a toTags helper", () => {
    expect(panelHtml).toContain("function toTags(value)");
    expect(panelHtml).toContain('value.split(",")');
  });

  it("never assumes item.tags is an array", () => {
    expect(panelHtml).not.toContain("(item.tags || []).map");
    expect(panelHtml).not.toContain('(item.tags || "").split');
  });

  it("uses the helper in both the memory and the skill renderer", () => {
    const uses = panelHtml.match(/toTags\(item\.tags\)/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
  });
});
