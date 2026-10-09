import { describe, expect, it } from "vite-plus/test";

import type { ResourcePressure } from "@/generated/types";
import { parseMemory } from "@/lib/k8s-quantity";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { cpuRatio, memoryRatio, schedulerShare } from "./health-share";

const pressure = (requested: number, allocatable: number) =>
  ({ requested, allocatable, usage: null }) as ResourcePressure;

describe("the scheduler headroom figures", () => {
  /**
   * Lena's Russian Overview read "0.8/2.0 cores" and "0.8/3.9Gi": a decimal
   * point and English units. Fails if either pair stops going through the
   * reader's decimal mark and unit names.
   */
  it("says the pair in the reader's language", () => {
    expect(cpuRatio(pressure(820, 2000), "ru")).toEqual({
      used: "0,8",
      total: "2,0",
      unit: " ядра",
    });
    expect(
      memoryRatio(
        pressure(parseMemory("820Mi"), parseMemory("4045636Ki")),
        "ru"
      )
    ).toEqual({ used: "0,8", total: "3,9", unit: " ГиБ" });
  });

  /** Fails if the English pair stops reading as kubectl's units. */
  it("keeps kubectl's units in English", () => {
    expect(cpuRatio(pressure(820, 2000), "en")).toEqual({
      used: "0.8",
      total: "2.0",
      unit: " cores",
    });
    expect(
      memoryRatio(
        pressure(parseMemory("820Mi"), parseMemory("4045636Ki")),
        "en"
      )
    ).toEqual({ used: "0.8", total: "3.9", unit: "Gi" });
  });
});

describe("the scheduler headroom share", () => {
  const t: T = (section, key, values) => translate("en", section, key, values);

  /**
   * The node page cuts a share down as kubectl describe node does; the
   * Overview rounded the same reservation up a point. Fails if it rounds.
   */
  it("is cut down to whole per cent as the node page cuts it", () => {
    const section = schedulerShare(
      { cpu: pressure(465, 1000), memory: pressure(32, 2048) },
      t
    );
    const texts = JSON.stringify(section.body);
    expect(texts).toContain("· 46%");
    expect(texts).toContain("· 1%");
    expect(texts).not.toContain("· 47%");
  });
});
