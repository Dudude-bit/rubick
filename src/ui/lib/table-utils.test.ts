import { describe, it, expect } from "vitest";
import { getResourceRowId } from "./table-utils";

describe("getResourceRowId", () => {
  it("prefers uid when present (cluster-unique)", () => {
    expect(
      getResourceRowId({
        name: "nginx",
        namespace: "default",
        uid: "abc-123",
      })
    ).toBe("abc-123");
  });

  it("falls back to namespace-name when uid missing", () => {
    expect(getResourceRowId({ name: "nginx", namespace: "default" })).toBe(
      "default-nginx"
    );
  });

  it("handles cluster-scoped resources (no namespace)", () => {
    expect(getResourceRowId({ name: "node-1" })).toBe("-node-1");
    expect(getResourceRowId({ name: "node-1", namespace: null })).toBe(
      "-node-1"
    );
  });

  it("treats empty uid as missing (uses fallback)", () => {
    expect(
      getResourceRowId({ name: "nginx", namespace: "default", uid: "" })
    ).toBe("default-nginx");
  });

  it("produces distinct ids for same name in different namespaces", () => {
    const a = getResourceRowId({ name: "api", namespace: "prod" });
    const b = getResourceRowId({ name: "api", namespace: "staging" });
    expect(a).not.toBe(b);
  });
});
