import { describe, it, expect, beforeEach } from "vitest";

import {
  PEEK_WIDTH_DEFAULT,
  PEEK_WIDTH_MAX,
  PEEK_WIDTH_MIN,
  useDisplaySettingsStore,
  type DisplaySettingsState,
} from "./displaySettingsStore";

describe("displaySettingsStore", () => {
  beforeEach(() => {
    useDisplaySettingsStore.setState({
      resourceColouring: "full",
      peekWidth: PEEK_WIDTH_DEFAULT,
    });
  });

  it("defaults resource colouring to full", () => {
    expect(useDisplaySettingsStore.getState().resourceColouring).toBe("full");
  });

  it("stores a new choice", () => {
    useDisplaySettingsStore.getState().setResourceColouring("off");
    expect(useDisplaySettingsStore.getState().resourceColouring).toBe("off");
  });

  it("remembers a dragged peek width", () => {
    useDisplaySettingsStore.getState().setPeekWidth(742);
    expect(useDisplaySettingsStore.getState().peekWidth).toBe(742);
  });

  // The viewport clamp lives in the panel; the store still refuses a width
  // that could never be sane on any window.
  it("refuses a width outside the bounds", () => {
    useDisplaySettingsStore.getState().setPeekWidth(12);
    expect(useDisplaySettingsStore.getState().peekWidth).toBe(PEEK_WIDTH_MIN);
    useDisplaySettingsStore.getState().setPeekWidth(9000);
    expect(useDisplaySettingsStore.getState().peekWidth).toBe(PEEK_WIDTH_MAX);
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

  it("gives every install written before version 3 the default peek width", () => {
    expect(migrate({ tableDensity: "compact" }, 2).peekWidth).toBe(
      PEEK_WIDTH_DEFAULT
    );
    expect(migrate(undefined, 0).peekWidth).toBe(PEEK_WIDTH_DEFAULT);
  });

  it("keeps a peek width the user already dragged", () => {
    expect(migrate({ peekWidth: 900 }, 3).peekWidth).toBe(900);
  });

  it("gives every install written before version 4 the full density strip", () => {
    expect(migrate({ peekWidth: 900 }, 3).densityStrip).toBe("full");
    expect(migrate(undefined, 0).densityStrip).toBe("full");
  });

  it("keeps a density strip mode the user already chose", () => {
    expect(migrate({ densityStrip: "band" }, 4).densityStrip).toBe("band");
    expect(migrate({ densityStrip: "off" }, 4).densityStrip).toBe("off");
  });

  it("pulls an out-of-range stored width back into bounds", () => {
    expect(migrate({ peekWidth: 40 }, 3).peekWidth).toBe(PEEK_WIDTH_MIN);
    expect(migrate({ peekWidth: 4000 }, 3).peekWidth).toBe(PEEK_WIDTH_MAX);
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
        state: {
          tableDensity: "compact",
          resourceColouring: "minimal",
          peekWidth: 820,
        },
        version: 3,
      })
    );
    await useDisplaySettingsStore.persist.rehydrate();
    expect(useDisplaySettingsStore.getState().resourceColouring).toBe(
      "minimal"
    );
    expect(useDisplaySettingsStore.getState().peekWidth).toBe(820);
  });
});
