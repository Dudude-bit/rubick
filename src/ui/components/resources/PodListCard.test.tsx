/**
 * What a workload's pod list says when the read did not work.
 *
 * "This workload owns no pods" is a claim about the cluster. A list nobody
 * was allowed to read, or that failed on the way, has made no such claim —
 * and the first sentence is the one somebody reads as "my deployment is
 * down". Three of the app's detail pages used to say it either way; two of
 * them by catching the failure and returning an empty array.
 */

import { describe, expect, it } from "vite-plus/test";
import { screen } from "@testing-library/react";

import { useLocaleStore } from "@/stores/localeStore";
import { renderWithRouter } from "@/test/render";
import { PodListCard } from "./PodListCard";
import type { PodInfo } from "@/generated/types";

// The card asks whether any of these pods sits on a node that stopped
// reporting, so it needs the provider the app always mounts around it.
const card = (props: { pods: PodInfo[]; error?: Error | null }) =>
  renderWithRouter(<PodListCard {...props} />, { at: "/c/prod" });

const pod = (name: string): PodInfo =>
  ({
    name,
    namespace: "default",
    status: { display: "Running" },
    restartCount: 0,
    containers: [{ name: "web", ready: true, state: { type: "running" } }],
    initContainers: [],
  }) as unknown as PodInfo;

describe("a pod list that could not be read", () => {
  it("does not claim the workload owns no pods", async () => {
    await card({ pods: [], error: new Error("connection refused") });
    expect(screen.queryByText(/no pods/i)).toBeNull();
    expect(screen.getByText(/could not read/i)).toBeTruthy();
  });

  it("quotes the reason, because the reader has to act on it", async () => {
    await card({ pods: [], error: new Error("connection refused") });
    expect(screen.getByText(/connection refused/i)).toBeTruthy();
  });

  /**
   * A refusal is not a failure. Saying "could not read" about one invites a
   * retry that will be refused the same way.
   */
  it("names a refusal as a refusal", async () => {
    await card({
      pods: [],
      error: new Error("pods is forbidden: User cannot list"),
    });
    expect(screen.getByText(/permission/i)).toBeTruthy();
    expect(screen.queryByText(/could not read/i)).toBeNull();
  });

  /** A workload that genuinely owns none still says so. */
  it("still says none when there is no error", async () => {
    await card({ pods: [] });
    expect(screen.getByText(/no pods/i)).toBeTruthy();
  });

  /**
   * A refetch that fails keeps the rows it already had — the failure only
   * replaces the list when there is nothing left to show.
   */
  it("keeps the rows it has when a refetch fails", async () => {
    const { container } = await card({
      pods: [pod("web-1")],
      error: new Error("connection refused"),
    });
    // The name is split across elements for highlighting, so read the row.
    expect(container.textContent).toContain("web-1");
    expect(screen.queryByText(/could not read/i)).toBeNull();
    expect(screen.queryByText(/connection refused/i)).toBeNull();
  });
});

describe("what a pod row says about its containers", () => {
  /**
   * The row detail was "1/1 ready · 3 restarts" in English on a Russian
   * page, and the restart count had one form for every number.
   */
  it("says readiness and restarts in the reader's language", async () => {
    useLocaleStore.setState({ choice: "ru" });
    try {
      const { container } = await card({
        pods: [{ ...pod("web-1"), restartCount: 3 } as PodInfo],
      });
      expect(container.textContent).toContain("готово 1/1 · 3 перезапуска");
      expect(container.textContent).not.toMatch(/ready|restarts/);
    } finally {
      useLocaleStore.setState({ choice: null });
    }
  });
});
