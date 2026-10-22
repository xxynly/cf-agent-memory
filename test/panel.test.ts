import panelHtml from "../public/index.html?raw";
import { describe, expect, it } from "vitest";

/**
 * The panel is a single static HTML file with no build step, so a mistake in it
 * only shows up at runtime in a browser. These tests pin the two contracts that
 * have already bitten us.
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

describe("panel view switching", () => {
  it("declares exactly two views", () => {
    expect(panelHtml).toContain('id="view-memory"');
    expect(panelHtml).toContain('id="view-skills"');
  });

  it("starts with the skills view hidden", () => {
    expect(panelHtml).toMatch(/<main id="view-skills"\s+hidden>/);
  });

  it("toggles .hidden on both views when a tab is clicked", () => {
    expect(panelHtml).toContain('$("view-memory").hidden = tab !== "memory"');
    expect(panelHtml).toContain('$("view-skills").hidden = tab !== "skills"');
  });

  /**
   * Author styles always beat the UA stylesheet, so `main { display: grid }`
   * silently overrides `[hidden] { display: none }` and the skills view renders
   * next to the memory view. The `[hidden]` rule must therefore be `!important`.
   */
  it("neutralises the main display rule for hidden views", () => {
    const setsDisplayOnMain = /main\s*\{[^}]*display\s*:/.test(panelHtml);
    expect(setsDisplayOnMain).toBe(true);

    expect(panelHtml).toMatch(/\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*;?\s*\}/);
  });

  it("loads skills when the skills tab is opened", () => {
    expect(panelHtml).toContain('if (tab === "skills") loadSkills()');
  });
});
