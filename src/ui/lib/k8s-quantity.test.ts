import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vite-plus/test";
import {
  parseQuantity,
  parseCPU,
  parseMemory,
  formatCPU,
  formatBytes,
} from "./k8s-quantity";

describe("parseQuantity", () => {
  it("returns null for empty / nullish input", () => {
    expect(parseQuantity(null)).toBeNull();
    expect(parseQuantity(undefined)).toBeNull();
    expect(parseQuantity("")).toBeNull();
    expect(parseQuantity("   ")).toBeNull();
  });

  it("parses bare numbers", () => {
    expect(parseQuantity("42")).toBe(42);
    expect(parseQuantity("0.5")).toBe(0.5);
    expect(parseQuantity("-1")).toBe(-1);
  });

  it("parses CPU units", () => {
    expect(parseQuantity("500m")).toBeCloseTo(0.5);
    expect(parseQuantity("100u")).toBeCloseTo(0.0001);
    expect(parseQuantity("1000n")).toBeCloseTo(0.000001);
  });

  it("parses binary memory units", () => {
    expect(parseQuantity("1Ki")).toBe(1024);
    expect(parseQuantity("1Mi")).toBe(1024 * 1024);
    expect(parseQuantity("2Gi")).toBe(2 * 1024 ** 3);
  });

  it("parses decimal memory units", () => {
    expect(parseQuantity("1k")).toBe(1000);
    // Refused by the API server, and by the backend.
    expect(parseQuantity("1K")).toBeNull();
    expect(parseQuantity("2M")).toBe(2_000_000);
  });

  it("returns null for malformed input", () => {
    expect(parseQuantity("abc")).toBeNull();
    expect(parseQuantity("1.2.3")).toBeNull();
    expect(parseQuantity("1XYZ")).toBeNull();
  });
});

describe("parseCPU", () => {
  it("returns 0 for empty input", () => {
    expect(parseCPU(null)).toBe(0);
    expect(parseCPU(undefined)).toBe(0);
    expect(parseCPU("")).toBe(0);
  });

  it("converts cores to millicores", () => {
    expect(parseCPU("2")).toBe(2000);
    expect(parseCPU("0.5")).toBe(500);
    expect(parseCPU("1.5")).toBe(1500);
  });

  it("preserves millicores", () => {
    expect(parseCPU("500m")).toBe(500);
    expect(parseCPU("250m")).toBe(250);
  });

  it("converts microcores to millicores", () => {
    // 1_000_000u = 1000m
    expect(parseCPU("1000000u")).toBe(1000);
  });

  it("converts nanocores to millicores", () => {
    // 100_000_000n = 100m
    expect(parseCPU("100000000n")).toBe(100);
  });

  it("returns 0 on malformed input", () => {
    expect(parseCPU("abc")).toBe(0);
    expect(parseCPU("xm")).toBe(0);
  });
});

describe("parseMemory", () => {
  it("returns 0 for empty input", () => {
    expect(parseMemory(null)).toBe(0);
    expect(parseMemory(undefined)).toBe(0);
    expect(parseMemory("")).toBe(0);
  });

  it("parses binary units precisely", () => {
    expect(parseMemory("1Ki")).toBe(1024);
    expect(parseMemory("512Mi")).toBe(512 * 1024 * 1024);
    expect(parseMemory("1Gi")).toBe(1024 ** 3);
    expect(parseMemory("1Ti")).toBe(1024 ** 4);
  });

  it("disambiguates k/Ki, M/Mi, G/Gi", () => {
    // k (decimal) vs Ki (binary)
    expect(parseMemory("1k")).toBe(1000);
    expect(parseMemory("1Ki")).toBe(1024);
    expect(parseMemory("1M")).toBe(1_000_000);
    expect(parseMemory("1Mi")).toBe(1_048_576);
  });

  it("parses bare bytes", () => {
    expect(parseMemory("1073741824")).toBe(1073741824);
  });
});

describe("formatCPU", () => {
  it("formats zero as 0m", () => {
    expect(formatCPU(0)).toBe("0m");
  });

  it("formats < 1000 millicores with m suffix", () => {
    expect(formatCPU(500)).toBe("500m");
    expect(formatCPU(250)).toBe("250m");
  });

  it("formats >= 1000 millicores as cores", () => {
    expect(formatCPU(1000)).toBe("1.0");
    expect(formatCPU(2500)).toBe("2.5");
  });
});

describe("formatCPU in the reader's language", () => {
  /** Fails if a whole-core reading stops following the reader's decimal mark. */
  it("writes cores with the reader's decimal mark", () => {
    expect(formatCPU(2500, "ru")).toBe("2,5");
    expect(formatCPU(250, "ru")).toBe("250m");
  });
});

describe("formatBytes", () => {
  it("formats zero", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  /**
   * Sam's Node page read "1.9 GB" and "202.0 MB" for kubectl's 1948912Ki and
   * 202Mi, beside an Overview and a PVC list in Gi. Fails if a byte count
   * stops reading in the binary units the API writes.
   */
  it("reads a node's capacity and requests in the units kubectl writes", () => {
    expect(formatBytes(parseMemory("1948912Ki"))).toBe("1.9Gi");
    expect(formatBytes(parseMemory("202Mi"), { trim: true })).toBe("202Mi");
    expect(formatBytes(parseMemory("202Mi"))).toBe("202.0Mi");
    expect(formatBytes(1536, { decimals: 2 })).toBe("1.50Ki");
    expect(formatBytes(1024 ** 4)).toBe("1.0Ti");
  });

  /**
   * Lena read "2,2 ГБ" on the Node page and "0.8/3.9Gi" on the Overview.
   * Fails if a size stops following the reader's units and decimal mark.
   */
  it("says a size in the reader's binary units and decimal mark", () => {
    expect(formatBytes(0, { locale: "ru" })).toBe("0 Б");
    expect(formatBytes(1536, { decimals: 2, locale: "ru" })).toBe("1,50 КиБ");
    expect(formatBytes(parseMemory("1948912Ki"), { locale: "ru" })).toBe(
      "1,9 ГиБ"
    );
    expect(
      formatBytes(parseMemory("202Mi"), { trim: true, locale: "ru" })
    ).toBe("202 МиБ");
  });

  /** Fails if a count stops being drawable in another count's unit, for a pair that has to compare. */
  it("reads a count in the scale it is told to", () => {
    expect(formatBytes(512 * 1024 ** 2, { scale: 3 })).toBe("0.5Gi");
  });
});
/**
 * The two parsers in this file read the same quantities, and one of them used
 * to know eight suffixes where the other knew thirteen. A PVC declaring `1Pi`
 * matched none of the eight, fell through to `parseFloat`, and the storage
 * block reported a petabyte as one byte — a number a reader has no way to
 * question, because it looks like a measurement.
 */
describe("the units the two parsers agree on", () => {
  it("reads every binary suffix Kubernetes writes", () => {
    expect(parseMemory("1Ki")).toBe(1024);
    expect(parseMemory("1Mi")).toBe(1024 ** 2);
    expect(parseMemory("1Gi")).toBe(1024 ** 3);
    expect(parseMemory("1Ti")).toBe(1024 ** 4);
    expect(parseMemory("1Pi")).toBe(1024 ** 5);
    expect(parseMemory("1Ei")).toBe(1024 ** 6);
  });

  it("reads every decimal suffix too", () => {
    expect(parseMemory("1k")).toBe(1e3);
    expect(parseMemory("1M")).toBe(1e6);
    expect(parseMemory("1G")).toBe(1e9);
    expect(parseMemory("1T")).toBe(1e12);
    expect(parseMemory("1P")).toBe(1e15);
    expect(parseMemory("1E")).toBe(1e18);
  });

  /** Whatever one answers, so does the other. */
  it("never disagrees with parseQuantity", () => {
    for (const value of [
      "1Ki",
      "512Mi",
      "1.5Gi",
      "1Ti",
      "1Pi",
      "1Ei",
      "1k",
      "1K",
      "1M",
      "1G",
      "1T",
      "1P",
      "1E",
      "1024",
      "0",
    ]) {
      expect(parseMemory(value)).toBe(parseQuantity(value) ?? 0);
    }
  });

  it("still answers zero for what is not a quantity", () => {
    expect(parseMemory("nonsense")).toBe(0);
    expect(parseMemory("")).toBe(0);
    expect(parseMemory(null)).toBe(0);
  });
});

describe("one grammar on both sides of the IPC boundary", () => {
  /**
   * The Rust side knew `K` and not `k`, this side knew both, and neither
   * read an exponent: one allocatable written `1k` was a thousand here and
   * unreadable there. The corpus is what both owe.
   */
  it("reads every quantity in the shared corpus as the backend does", () => {
    const corpus = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "src/contracts/quantity-conformance.json"),
        "utf8"
      )
    ) as { cases: Array<{ input: string; value: number | null }> };

    for (const { input, value } of corpus.cases) {
      const got = parseQuantity(input);
      if (value === null) {
        expect(got, JSON.stringify(input)).toBeNull();
      } else {
        expect(got, JSON.stringify(input)).not.toBeNull();
        expect(Math.abs(got! - value)).toBeLessThanOrEqual(
          Math.abs(value) * 1e-12
        );
      }
    }
  });
});
