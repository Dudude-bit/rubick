/**
 * What a workload's pod list says when the read did not work.
 *
 * "This workload owns no pods" is a claim about the cluster. A list nobody
 * was allowed to read, or that failed on the way, has made no such claim —
 * and the first sentence is the one somebody reads as "my deployment is
 * down". Three of the app's detail pages used to say it either way; two of
 * them by catching the failure and returning an empty array.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { PodListCard } from "./PodListCard";
import type { PodInfo } from "@/generated/types";

const card = (props: { pods: PodInfo[]; error?: Error | null }) =>
  render(
    <MemoryRouter>
      <PodListCard {...props} />
    </MemoryRouter>
  );

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
  it("does not claim the workload owns no pods", () => {
    card({ pods: [], error: new Error("connection refused") });
    expect(screen.queryByText(/no pods/i)).toBeNull();
    expect(screen.getByText(/could not read/i)).toBeTruthy();
  });

  it("quotes the reason, because the reader has to act on it", () => {
    card({ pods: [], error: new Error("connection refused") });
    expect(screen.getByText(/connection refused/i)).toBeTruthy();
  });

  /**
   * A refusal is not a failure. Saying "could not read" about one invites a
   * retry that will be refused the same way.
   */
  it("names a refusal as a refusal", () => {
    card({ pods: [], error: new Error("pods is forbidden: User cannot list") });
    expect(screen.getByText(/permission/i)).toBeTruthy();
    expect(screen.queryByText(/could not read/i)).toBeNull();
  });

  /** A workload that genuinely owns none still says so. */
  it("still says none when there is no error", () => {
    card({ pods: [] });
    expect(screen.getByText(/no pods/i)).toBeTruthy();
  });

  /**
   * A refetch that fails keeps the rows it already had — the failure only
   * replaces the list when there is nothing left to show.
   */
  it("keeps the rows it has when a refetch fails", () => {
    const { container } = card({
      pods: [pod("web-1")],
      error: new Error("connection refused"),
    });
    // The name is split across elements for highlighting, so read the row.
    expect(container.textContent).toContain("web-1");
    expect(screen.queryByText(/could not read/i)).toBeNull();
    expect(screen.queryByText(/connection refused/i)).toBeNull();
  });
});
