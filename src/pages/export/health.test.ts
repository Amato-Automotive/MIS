/**
 * The colour contract for Export lead health.
 *
 * The traffic light is only readable if each step looks like the thing it
 * means everywhere else on the page: red is the overdue-action red, amber the
 * gone-quiet amber. These pin that down so a later "tweak the shade" gets a
 * failing test instead of a second red.
 */
import { describe, it, expect } from "vitest";
import { HEALTH, HEALTH_ORDER, KPI } from "./shared";

describe("health palette", () => {
  it("borrows the page's existing meanings for red, amber and green", () => {
    expect(HEALTH.critical.swatch).toBe(KPI.danger.color);
    expect(HEALTH.at_risk.swatch).toBe(KPI.warning.color);
    expect(HEALTH.on_track.swatch).toBe(KPI.conversion.color);
    expect(HEALTH.watch.swatch).toBe(KPI.caution.color);
  });

  it("gives every level its own swatch", () => {
    expect(new Set(HEALTH_ORDER.map((lv) => HEALTH[lv].swatch)).size).toBe(HEALTH_ORDER.length);
  });

  it("is never the open-pipeline orange", () => {
    // Orange is "open pipeline" on this page; a lead's health must not read as it.
    for (const lv of HEALTH_ORDER) expect(HEALTH[lv].swatch).not.toBe("#f46617");
  });

  it("lists every level once, worst first", () => {
    expect(HEALTH_ORDER).toEqual(["critical", "at_risk", "watch", "on_track", "parked", "unknown"]);
  });

  it("keeps readable text: no gray-300/400 on the labels", () => {
    for (const lv of HEALTH_ORDER) {
      expect(HEALTH[lv].text).not.toMatch(/gray-(300|400)/);
      expect(HEALTH[lv].chip).not.toMatch(/text-gray-(300|400)/);
    }
  });
});
