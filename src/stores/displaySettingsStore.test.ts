import { describe, it, expect, beforeEach, vi } from "vitest";

// Node 26 defines a global `localStorage` that stays undefined without
// `--localstorage-file`, and it shadows jsdom's. `persist` reads it once at
// import time, so the stub has to be hoisted above the store import.
vi.hoisted(() => {
  const memory = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
    key: (index: number) => [...memory.keys()][index] ?? null,
    get length() {
      return memory.size;
    },
  };
});

import {
  useDisplaySettingsStore,
  type DisplaySettingsState,
} from "./displaySettingsStore";

describe("displaySettingsStore", () => {
  beforeEach(() => {
    useDisplaySettingsStore.setState({ resourceColouring: "full" });
  });

  it("defaults resource colouring to full", () => {
    expect(useDisplaySettingsStore.getState().resourceColouring).toBe("full");
  });

  it("stores a new choice", () => {
    useDisplaySettingsStore.getState().setResourceColouring("off");
    expect(useDisplaySettingsStore.getState().resourceColouring).toBe("off");
  });
});

describe("displaySettingsStore migration", () => {
  const migrate = (persisted: unknown, version: number) => {
    const fn = useDisplaySettingsStore.persist.getOptions().migrate;
    if (!fn) throw new Error("no migrate configured");
    return fn(persisted, version) as DisplaySettingsState;
  };

  it("gives a version-0 install the compact density and the colouring default", () => {
    expect(migrate({ tableDensity: "comfortable" }, 0)).toMatchObject({
      tableDensity: "compact",
      resourceColouring: "full",
    });
  });

  it("gives a version-1 install the colouring default it never had on disk", () => {
    const migrated = migrate({ tableDensity: "comfortable" }, 1);
    expect(migrated.resourceColouring).toBe("full");
    // The density migration already ran for this install; re-running it would
    // undo a choice the user made after the last upgrade.
    expect(migrated.tableDensity).toBe("comfortable");
  });

  it("keeps a colouring the user already chose", () => {
    expect(
      migrate({ tableDensity: "compact", resourceColouring: "off" }, 2)
        .resourceColouring
    ).toBe("off");
    expect(
      migrate({ tableDensity: "compact", resourceColouring: "minimal" }, 2)
        .resourceColouring
    ).toBe("minimal");
  });

  it("survives an empty or missing persisted payload", () => {
    expect(migrate(undefined, 1).resourceColouring).toBe("full");
    expect(migrate({}, 2).resourceColouring).toBe("full");
  });

  // Calling `migrate` directly proves the function; only rehydration proves
  // the version bump actually routes an on-disk payload through it.
  it("rehydrates a real on-disk version-1 payload with the default", async () => {
    localStorage.setItem(
      "display-settings",
      JSON.stringify({ state: { tableDensity: "comfortable" }, version: 1 })
    );
    await useDisplaySettingsStore.persist.rehydrate();
    expect(useDisplaySettingsStore.getState().resourceColouring).toBe("full");
    expect(useDisplaySettingsStore.getState().tableDensity).toBe("comfortable");
  });

  it("rehydrates a current payload without touching the stored choice", async () => {
    localStorage.setItem(
      "display-settings",
      JSON.stringify({
        state: { tableDensity: "compact", resourceColouring: "minimal" },
        version: 2,
      })
    );
    await useDisplaySettingsStore.persist.rehydrate();
    expect(useDisplaySettingsStore.getState().resourceColouring).toBe(
      "minimal"
    );
  });
});
