/**
 * Net PAT margin classification. A wrong band is a plausible-looking wrong
 * answer — a loss-making unit painted Red instead of Dark Red reads fine —
 * so the edges are pinned here.
 */
import { describe, it, expect } from "vitest";
import { classifyMargin, netPatMargin } from "./margin";

const band = (pct: number) => classifyMargin(pct / 100)?.label;

describe("classifyMargin", () => {
  it("matches the finance key's sample (1.8% → Red)", () => {
    expect(classifyMargin(netPatMargin(65.92, 1.19))?.label).toBe("Red");
  });

  it("puts each boundary in the band it opens", () => {
    expect(band(-4)).toBe("Dark Red");
    expect(band(0)).toBe("Red");
    expect(band(4)).toBe("Orange");
    expect(band(8)).toBe("Green");
    expect(band(12)).toBe("Blue");
  });

  it("covers both open ends", () => {
    expect(band(-30)).toBe("Black");
    expect(band(-4.1)).toBe("Black");
    expect(band(-0.1)).toBe("Dark Red");
    expect(band(45)).toBe("Blue");
  });

  it("classifies by the percent shown, not float noise", () => {
    expect(band(3.9996)).toBe("Orange"); // displays as 4.0%
  });

  it("has no band without turnover", () => {
    expect(netPatMargin(0, 5)).toBeNull();
    expect(netPatMargin(null, 5)).toBeNull();
    expect(classifyMargin(null)).toBeNull();
  });
});
