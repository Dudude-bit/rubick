import { describe, expect, it } from "vitest";
import { formatQuantity, splitUnit, usageRole } from "@/lib/metric-format";
import { formatCPU, formatMemory } from "@/lib/k8s-quantity";

describe("splitUnit", () => {
  it("splits a millicore value", () => {
    expect(splitUnit("999m")).toEqual({ value: "999", unit: "m" });
  });

  it("splits a two-letter binary unit", () => {
    expect(splitUnit("1.81Gi")).toEqual({ value: "1.81", unit: "Gi" });
    expect(splitUnit("65.5Mi")).toEqual({ value: "65.5", unit: "Mi" });
  });

  it("leaves a bare number without a unit", () => {
    expect(splitUnit("2.5")).toEqual({ value: "2.5", unit: "" });
    expect(splitUnit("0")).toEqual({ value: "0", unit: "" });
  });

  it("keeps a space-separated unit", () => {
    expect(splitUnit("12.00 Bytes")).toEqual({ value: "12.00", unit: "Bytes" });
  });

  it("survives a negative value", () => {
    expect(splitUnit("-3Gi")).toEqual({ value: "-3", unit: "Gi" });
  });

  it("returns non-numeric placeholders whole", () => {
    expect(splitUnit("-")).toEqual({ value: "-", unit: "" });
    expect(splitUnit("n/a")).toEqual({ value: "n/a", unit: "" });
    expect(splitUnit("")).toEqual({ value: "", unit: "" });
  });

  it("does not mangle what the formatters actually produce", () => {
    expect(splitUnit(formatCPU(999))).toEqual({ value: "999", unit: "m" });
    expect(splitUnit(formatCPU(2500))).toEqual({ value: "2.5", unit: "" });
    expect(splitUnit(formatMemory(1024 ** 3 * 1.81))).toEqual({
      value: "1.81",
      unit: "Gi",
    });
  });
});

describe("usageRole", () => {
  it("stays ok below three quarters", () => {
    expect(usageRole(0)).toBe("ok");
    expect(usageRole(0.43)).toBe("ok");
  });

  it("treats the thresholds themselves as the lower role", () => {
    expect(usageRole(0.75)).toBe("ok");
    expect(usageRole(0.9)).toBe("warn");
  });

  it("warns just past three quarters", () => {
    expect(usageRole(0.7501)).toBe("warn");
    expect(usageRole(0.88)).toBe("warn");
  });

  it("errs just past ninety percent", () => {
    expect(usageRole(0.9001)).toBe("err");
    expect(usageRole(0.96)).toBe("err");
  });

  it("keeps overcommit red rather than wrapping around", () => {
    expect(usageRole(1)).toBe("err");
    expect(usageRole(4.2)).toBe("err");
  });
});

describe("throughput", () => {
  /**
   * Would break if a rate came back as a raw float. `formatMemory` returns
   * the number unchanged below 1Ki — correct for the integer byte counts it
   * was written for, and unreadable for a rate: an idle pod read
   * "10.523997160968209/s" on screen before this.
   */
  it("rounds a sub-kibibyte rate to whole bytes and names the unit", () => {
    expect(formatQuantity(10.523997160968209, "throughput")).toBe("11B/s");
    expect(formatQuantity(0, "throughput")).toBe("0B/s");
  });

  /** And the `/s` is never dropped, or traffic reads as resident memory. */
  it("keeps the per-second, so traffic cannot be read as memory", () => {
    expect(formatQuantity(2 * 1024 * 1024, "throughput")).toBe("2Mi/s");
    expect(formatQuantity(2 * 1024 * 1024, "memory")).toBe("2Mi");
  });
});
