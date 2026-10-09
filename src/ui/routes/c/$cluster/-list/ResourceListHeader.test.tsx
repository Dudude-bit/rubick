import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/commands", () => ({ commands: {} }));

import { TooltipProvider } from "@/components/ui/tooltip";
import { useClusterStore } from "@/stores/clusterStore";
import { ResourceListHeader } from "./ResourceListHeader";

beforeEach(() => {
  useClusterStore.setState({ isConnected: true });
});

describe("ResourceListHeader", () => {
  /**
   * The freshness reading keeps room for its longest wording and sits at the
   * right of that room, so Share placed before it floated mid-row at 1024
   * while the Overview's sat at the edge. Fails if anything follows the
   * actions in the row.
   */
  it("ends the row with the actions, after the freshness reading", () => {
    render(
      <TooltipProvider>
        <ResourceListHeader
          title="Pods"
          count={13}
          dataUpdatedAt={Date.now()}
          live
          actions={<button type="button">Share</button>}
        />
      </TooltipProvider>
    );
    const share = screen.getByRole("button", { name: "Share" });
    const live = screen.getByText("live");
    expect(share.parentElement?.lastElementChild).toBe(share);
    expect(
      live.compareDocumentPosition(share) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
