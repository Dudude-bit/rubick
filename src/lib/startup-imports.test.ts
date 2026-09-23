import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob<string>(
  ["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}", "!/src/generated/**"],
  { query: "?raw", import: "default", eager: true }
);

/** Modules that load after startup: the editor's chunk and a lazy route. */
const MAY_IMPORT_YAML = new Set([
  "/src/components/yaml/manifest-reads.ts",
  "/src/lib/helm-manifest.ts",
  "/src/pages/HelmDetail.tsx",
]);

describe("what startup loads", () => {
  /**
   * The YAML parser is 57 kB that no screen needs until an object is opened
   * for editing, and one static import anywhere on the startup graph puts it
   * back in the first load. A module that needs it at startup reaches it
   * with `await import("js-yaml")`.
   */
  it("imports js-yaml statically only where it loads after startup", () => {
    const eager = Object.entries(SOURCES)
      .filter(
        ([path, source]) =>
          !MAY_IMPORT_YAML.has(path) &&
          /^import[^;]*from\s*["']js-yaml["']/m.test(source)
      )
      .map(([path]) => path);
    expect(Object.keys(SOURCES).length).toBeGreaterThan(500);
    expect(eager).toEqual([]);
  });
});
