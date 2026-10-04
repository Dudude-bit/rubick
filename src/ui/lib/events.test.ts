import { describe, expect, it } from "vite-plus/test";

const SOURCES = import.meta.glob<string>(
  [
    "/src/ui/**/*.{ts,tsx}",
    "!/src/ui/**/*.test.{ts,tsx}",
    "!/src/ui/generated/**",
  ],
  { query: "?raw", import: "default", eager: true }
);

/** The IPC adapter, and the host's window events, which are not the backend's. */
const MAY_LISTEN = new Set([
  "/src/ui/lib/transport/ipc.ts",
  "/src/ui/lib/host/tauri.ts",
]);

describe("listening to the backend", () => {
  /**
   * Thirty payload interfaces were written out by hand, each "mirroring" a
   * Rust struct nothing compared it with. `listenEvent` takes the type from
   * the generated union instead; a bare `listen<T>` brings the hand-written
   * copy back.
   */
  it("goes through listenEvent, which types the payload from the Rust enum", () => {
    const bare = Object.entries(SOURCES)
      .filter(
        ([path, source]) =>
          !MAY_LISTEN.has(path) &&
          /import\s*\{[^}]*\blisten\b[^}]*\}\s*from\s*["']@tauri-apps\/api\/event["']/.test(
            source
          )
      )
      .map(([path]) => path);
    expect(Object.keys(SOURCES).length).toBeGreaterThan(500);
    expect(bare).toEqual([]);
  });
});
