import { describe, expect, it } from "vitest";
import { recencyBoost, rrfFuse } from "../src/lib/rrf.js";

describe("rrfFuse", () => {
  it("ranks items appearing in both lists above single-list items", () => {
    const fused = rrfFuse([
      { ids: ["a", "b", "c"] },
      { ids: ["c", "d"] },
    ]);
    expect(fused[0]?.id).toBe("c");
  });

  it("preserves single-list ordering when there is no overlap", () => {
    const fused = rrfFuse([{ ids: ["a", "b"] }, { ids: ["c", "d"] }]);
    expect(fused.slice(0, 2).map((f) => f.id)).toEqual(["a", "c"]);
  });

  it("honours weights", () => {
    const fused = rrfFuse([
      { ids: ["vector-hit"], weight: 0.1 },
      { ids: ["keyword-hit"], weight: 3 },
    ]);
    expect(fused[0]?.id).toBe("keyword-hit");
  });

  it("returns an empty array for empty input", () => {
    expect(rrfFuse([{ ids: [] }])).toEqual([]);
  });
});

describe("recencyBoost", () => {
  const now = Date.UTC(2026, 9, 22);

  it("is 1 for a brand new memory", () => {
    expect(recencyBoost(now, now)).toBeCloseTo(1);
  });

  it("halves at the half-life", () => {
    expect(recencyBoost(now - 30 * 86_400_000, now)).toBeCloseTo(0.5, 2);
  });

  it("decays monotonically", () => {
    const fresh = recencyBoost(now - 86_400_000, now);
    const old = recencyBoost(now - 90 * 86_400_000, now);
    expect(fresh).toBeGreaterThan(old);
  });
});
