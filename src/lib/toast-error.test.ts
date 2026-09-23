import { beforeEach, describe, expect, it, vi } from "vitest";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/components/ui/use-toast", () => ({ toast }));

import { toastError } from "./toast-error";

const SOURCES = import.meta.glob<string>(
  ["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}", "!/src/generated/**"],
  { query: "?raw", import: "default", eager: true }
);

/**
 * Where the message is kept or compared rather than shown. Not a store: a
 * store's error is read by every screen that shows it, and one of them
 * forgetting `verbatim` is how the toast beside the cluster door and the
 * alert panel printed "Tauri command 'connectCluster' failed:".
 */
const KEEPS_THE_PREFIX = new Set([
  "/src/lib/error-utils.ts",
  "/src/lib/commands.ts",
  "/src/components/terminal/PodTerminal.tsx",
]);

/**
 * Every spelling of a caught failure read by hand: the `instanceof` guard,
 * `String(error)` — which adds "Error: " in front of the prefix, so even
 * `verbatim` cannot take it off — a cast, a bare `.message`, and the
 * `.message` of what `reportError` hands back, which is the logged form.
 */
const BY_HAND = new RegExp(
  [
    String.raw`instanceof Error\s*\?\s*[\w.]+\.message`,
    String.raw`String\(\s*(?:e|err|error)\s*\)`,
    String.raw`as Error\)\.message`,
    String.raw`\b(?:err|error)\??\.message\b`,
    String.raw`\bnormalized\??\.message\b`,
  ].join("|"),
  "g"
);

/** Where that spelling is compared, logged or kept, and never shown. */
const NOT_SHOWN = new Map([
  ["/src/lib/error-utils.ts", "the normaliser itself"],
  ["/src/lib/read-deadline.ts", "searched for a marker"],
  ["/src/lib/log-queue.ts", "kept for the retry"],
  ["/src/main.tsx", "logged"],
  ["/src/integrations/cloudnativepg/page.tsx", "compared with sentinels"],
  ["/src/workers/diff.worker.ts", "a worker's own failure, not a command's"],
  ["/src/stores/updaterStore.ts", "the updater plugin's, not a command's"],
  ["/src/App.tsx", "a render error, not a command's"],
  ["/src/components/ui/error-boundary.tsx", "a render error, not a command's"],
  ["/src/hooks/useIngressRouting.ts", "searched for a verdict"],
  ["/src/hooks/useDeepLinks.ts", "logged"],
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

  /**
   * The same message spelled by hand — `error instanceof Error ?
   * error.message : …` — slipped past the check above on five vendor pages
   * and in `errorWords`, the words of every toast built from a caught error.
   * Matching that one spelling let `String(error)` and a bare `.message`
   * put "Tauri command 'probeResolveHost' failed:" on a route trace, a
   * GatewayClass, the debug dialog and six more screens.
   */
  it("is not read off error.message by hand anywhere it is shown", () => {
    const shown = Object.entries(SOURCES).flatMap(([path, source]) =>
      NOT_SHOWN.has(path)
        ? []
        : source
            .split("\n")
            .flatMap((line, index) =>
              /^\s*(\*|\/\/|\/\*)/.test(line) || !line.match(BY_HAND)
                ? []
                : [`${path}:${index + 1}`]
            )
    );
    expect(shown).toEqual([]);
  });
});
