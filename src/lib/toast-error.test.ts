import { beforeEach, describe, expect, it, vi } from "vitest";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/components/ui/use-toast", () => ({ toast }));

import { toastError } from "./toast-error";

const SOURCES = import.meta.glob<string>(
  ["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}", "!/src/generated/**"],
  { query: "?raw", import: "default", eager: true }
);

/** Where the message is kept or compared rather than shown. */
const KEEPS_THE_PREFIX = new Set([
  "/src/lib/error-utils.ts",
  "/src/lib/commands.ts",
  "/src/stores/clusterStore.ts",
  "/src/components/terminal/PodTerminal.tsx",
]);

describe("a failure shown to the reader", () => {
  beforeEach(() => toast.mockClear());

  /** "Tauri command 'deletePod' failed:" is our framing, not the server's words. */
  it("gives the server's words without the command in front", () => {
    toastError(
      "Could not delete",
      new Error(
        'Tauri command \'deletePod\' failed: pods "web" is forbidden: User "kirya" cannot delete resource "pods"'
      )
    );
    expect(toast).toHaveBeenCalledWith({
      title: "Could not delete",
      description:
        'pods "web" is forbidden: User "kirya" cannot delete resource "pods"',
      variant: "destructive",
    });
  });

  /**
   * About eighty toasts and inline lines passed `normalizeTauriError` — or
   * `String(err)` — straight to the screen, prefix and all. It is for a
   * message that is thrown or matched; one that is shown goes through
   * `errorToShow`.
   */
  it("is not built from the prefixed message anywhere it is shown", () => {
    const shown = Object.entries(SOURCES).flatMap(([path, source]) =>
      KEEPS_THE_PREFIX.has(path)
        ? []
        : source
            .split("\n")
            .filter(
              (line) =>
                line.includes("normalizeTauriError(") &&
                !/throw\b/.test(line) &&
                !line.trimStart().startsWith("import")
            )
            .map((line) => `${path}: ${line.trim()}`)
    );
    expect(Object.keys(SOURCES).length).toBeGreaterThan(500);
    expect(shown).toEqual([]);
  });
});
