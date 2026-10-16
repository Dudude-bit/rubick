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

const CART = "/c/acme-staging/pods/shop/cart-4f68h";
const pageOf = (each: KeptShell) =>
  `/c/${each.context}/pods/${each.namespace}/${each.pod}`;
const tabs = (
  activeId: string,
  pendingHref: string | null = null,
  landedOn: string | null = CART
) => ({ ids: ["a", "b"], activeId, pendingHref, landedOn });

beforeEach(() => useKeptShellStore.setState({ shells: [] }));

describe("which kept shell its owner has let go of", () => {
  /** Fails if a parked tab's shell is ended, which is what Dana lost on every tab switch. */
  it("keeps the shell of a tab that is not on screen, wherever that tab is", () => {
    expect(strandedShell([shell("a", "elsewhere")], tabs("b"), pageOf)).toBe(
      null
    );
  });

  /** Fails if a tab still on its way back is judged by the page it is leaving. */
  it("keeps the shell of a tab that has not landed yet", () => {
    expect(
      strandedShell(
        [shell("a", "elsewhere")],
        tabs("a", "/c/acme-staging/pods/shop/elsewhere"),
        pageOf
      )
    ).toBe(null);
  });

  /**
   * The bridge settles a tab the moment the router starts for its route,
   * while the router still reports the page being left. Fails if a shell is
   * judged by that page, which ended Dana's on every click back to its tab.
   */
  it("keeps the shell of a tab on screen while the window is between two routes", () => {
    expect(strandedShell([shell("a")], tabs("a", null, null), pageOf)).toBe(
      null
    );
  });

  /** Fails if a shell is ended under a reader still on its page. */
  it("keeps the shell of a tab on screen and on its pod", () => {
    expect(strandedShell([shell("a")], tabs("a"), pageOf)).toBe(null);
  });

  /** Fails if a tab that moved off the pod keeps its shell, or ends it without a reason to say. */
  it("ends the shell of a tab on screen that left the pod, as a page left", () => {
    const left = shell("a", "elsewhere");
    expect(strandedShell([left], tabs("a"), pageOf)).toEqual({
      shell: left,
      why: "leftPage",
    });
  });

  /** Fails if a closed tab's shell outlives it, parked or not. */
  it("ends the shell of a tab that is gone", () => {
    const orphan = shell("closed");
    expect(strandedShell([orphan], tabs("a"), pageOf)).toEqual({
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
