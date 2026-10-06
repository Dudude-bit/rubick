import { describe, expect, it } from "vite-plus/test";

import type { ResourcePressure } from "@/generated/types";
import { parseMemory } from "@/lib/k8s-quantity";
import { cpuRatio, memoryRatio } from "./health-share";

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
