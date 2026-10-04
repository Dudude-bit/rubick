import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CODE_FILES } from "@/test/source-files";

/** `from "..."`, a bare `import "..."` and a dynamic `import("...")`. */
const TAURI_IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*["']@tauri-apps\//;

const ADAPTERS = new Set([
  "src/ui/lib/transport/ipc.ts",
  "src/ui/lib/host/tauri.ts",
]);

describe("the boundary between the app and Tauri", () => {
  /**
   * A screen importing Tauri directly works on the desktop and breaks the
   * moment the same code runs over a socket, with nothing failing until then.
   */
  it("is crossed only by the two adapters", () => {
    const crossing = CODE_FILES.filter(
      (path) =>
        !ADAPTERS.has(path) &&
        !path.startsWith("src/ui/generated/") &&
        path !== "src/ui/test-setup.ts" &&
        TAURI_IMPORT.test(readFileSync(path, "utf8"))
    );
    expect(CODE_FILES.length).toBeGreaterThan(500);
    expect(crossing).toEqual([]);
  });

  /**
   * The generator writes Tauri's invoke into every binding; the Makefile step
   * that points it at the transport is the only thing putting the 262
   * commands behind it. Regenerating without that step would bypass it.
   */
  it("is where the generated commands send every call", () => {
    const bindings = readFileSync("src/ui/generated/commands.ts", "utf8");
    expect(bindings).toContain('import { invoke } from "@/lib/transport";');
    expect(bindings).not.toMatch(TAURI_IMPORT);
  });
});
