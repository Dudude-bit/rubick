import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  heard,
  scrollbackOf,
  strandedShell,
  useKeptShellStore,
  type KeptShell,
} from "./keptShellStore";

const shell = (tab: string, pod = "cart-4f68h"): KeptShell => ({
  id: `term-${tab}-${pod}`,
  tab,
  context: "acme-staging",
  namespace: "shop",
  pod,
  container: "app",
});

const onCart = (each: KeptShell) => each.pod === "cart-4f68h";
const tabs = (activeId: string, pendingHref: string | null = null) => ({
  ids: ["a", "b"],
  activeId,
  pendingHref,
});

beforeEach(() => useKeptShellStore.setState({ shells: [] }));

describe("which kept shell its owner has let go of", () => {
  /** Fails if a parked tab's shell is ended, which is what Dana lost on every tab switch. */
  it("keeps the shell of a tab that is not on screen, wherever that tab is", () => {
    expect(strandedShell([shell("a", "elsewhere")], tabs("b"), onCart)).toBe(
      null
    );
  });

  /** Fails if a tab still on its way back is judged by the page it is leaving. */
  it("keeps the shell of a tab that has not landed yet", () => {
    expect(
      strandedShell(
        [shell("a", "elsewhere")],
        tabs("a", "/c/acme-staging/pods/shop/elsewhere"),
        onCart
      )
    ).toBe(null);
  });

  /** Fails if a shell is ended under a reader still on its page. */
  it("keeps the shell of a tab on screen and on its pod", () => {
    expect(strandedShell([shell("a")], tabs("a"), onCart)).toBe(null);
  });

  /** Fails if a tab that moved off the pod keeps its shell, or ends it without a reason to say. */
  it("ends the shell of a tab on screen that left the pod, as a page left", () => {
    const left = shell("a", "elsewhere");
    expect(strandedShell([left], tabs("a"), onCart)).toEqual({
      shell: left,
      why: "leftPage",
    });
  });

  /** Fails if a closed tab's shell outlives it, parked or not. */
  it("ends the shell of a tab that is gone", () => {
    const orphan = shell("closed");
    expect(strandedShell([orphan], tabs("a"), onCart)).toEqual({
      shell: orphan,
      why: "tabClosed",
    });
  });
});

describe("what a kept shell printed", () => {
  /** Fails if output of a shell nobody keeps is held, or a kept one's is lost. */
  it("is held for kept shells only, until they are let go of", () => {
    const kept = shell("a");
    useKeptShellStore.getState().keep(kept);
    heard(kept.id, "/srv/app # ");
    heard(kept.id, "ls\r\n");
    heard("term-unkept", "secret");

    expect(scrollbackOf(kept.id)).toBe("/srv/app # ls\r\n");
    expect(scrollbackOf("term-unkept")).toBe("");

    useKeptShellStore.getState().forget(kept.id);
    expect(scrollbackOf(kept.id)).toBe("");
  });

  /** Fails if a busy shell grows without bound, or is cut mid-line. */
  it("keeps the last 256 KiB, from the start of a line", () => {
    const kept = shell("a");
    useKeptShellStore.getState().keep(kept);
    const line = `${"x".repeat(1023)}\n`;
    for (let i = 0; i < 300; i++) heard(kept.id, line);
    heard(kept.id, "tail");

    const held = scrollbackOf(kept.id);
    expect(held.length).toBeLessThanOrEqual(256 * 1024);
    expect(held.length).toBeGreaterThan(255 * 1024);
    expect(held.startsWith("x".repeat(1023))).toBe(true);
    expect(held.endsWith("\ntail")).toBe(true);
  });
});
