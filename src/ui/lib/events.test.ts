import { describe, expect, it } from "vite-plus/test";

import { listenResourceEvents, type EventPayload } from "./events";
import { setTransport, transport, type Transport } from "./transport";

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

/**
 * Tauri's order on unlisten: the window forgets the callback at once, the
 * backend stops sending to it one IPC round trip later. A batch in between
 * finds no callback, which the webview logs as "Couldn't find callback id".
 */
function tauriLike() {
  const callbacks = new Map<number, (payload: unknown) => void>();
  const backend = new Set<number>();
  const missing: number[] = [];
  let next = 0;
  const fake: Transport = {
    kind: "fake",
    invoke: async () => {
      throw new Error("no commands here");
    },
    listen: async (_channel, onEvent) => {
      const id = next++;
      callbacks.set(id, onEvent as (payload: unknown) => void);
      backend.add(id);
      return () => {
        callbacks.delete(id);
        void Promise.resolve().then(() => backend.delete(id));
      };
    },
    status: () => "open",
    onStatus: () => () => {},
  };
  const emit = (payload: EventPayload<"resource-event">) => {
    for (const id of backend) {
      const callback = callbacks.get(id);
      if (callback) callback(payload);
      else missing.push(id);
    }
  };
  return { fake, emit, missing, backend };
}

const batch = (stream_id: string): EventPayload<"resource-event"> => ({
  channel: "resource-event",
  stream_id,
  changes: [],
  error: null,
});

describe("watches coming and going on the shared channel", () => {
  /**
   * Every watch registered its own Tauri listener, so one leaving while
   * another's batch was in flight logged "Couldn't find callback id": three
   * after leaving Deployments, two as Marco's refused watches stopped.
   */
  it("lets a watch leave without the backend sending to a forgotten callback", async () => {
    const real = transport();
    const { fake, emit, missing, backend } = tauriLike();
    setTransport(fake);
    try {
      const heardA: string[] = [];
      const heardB: string[] = [];
      const offA = await listenResourceEvents((event) =>
        heardA.push(event.payload.stream_id)
      );
      const offB = await listenResourceEvents((event) =>
        heardB.push(event.payload.stream_id)
      );

      offA();
      emit(batch("b"));
      await Promise.resolve();
      emit(batch("b"));

      expect(missing).toEqual([]);
      expect(heardA).toEqual([]);
      expect(heardB).toEqual(["b", "b"]);

      offB();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(backend.size).toBe(0);
    } finally {
      setTransport(real);
    }
  });
  /** A listener that failed to register must not stay the shared one. */
  it("asks again for the shared listener after one failed to register", async () => {
    const real = transport();
    const { fake, emit } = tauriLike();
    const listen = fake.listen;
    let refuse = true;
    setTransport({
      ...fake,
      listen: (channel, onEvent) =>
        refuse
          ? Promise.reject(new Error("not ready"))
          : listen(channel, onEvent),
    });
    try {
      await expect(listenResourceEvents(() => {})).rejects.toThrow("not ready");
      refuse = false;
      const heard: string[] = [];
      const off = await listenResourceEvents((event) =>
        heard.push(event.payload.stream_id)
      );
      emit(batch("a"));
      expect(heard).toEqual(["a"]);
      off();
    } finally {
      setTransport(real);
    }
  });
});
