import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { ResourceDetailHeader } from "./ResourceDetailHeader";

beforeEach(() => {
  useClusterStore.setState({ isConnected: true, currentContext: "prod" });
});

describe("the reading beside the name", () => {
  /**
   * At 1024 in Russian the reading sat right-aligned on the owner row above
   * the name and the age wrapped onto a row of its own, because the reading
   * held a column as wide as its longest Russian state. Fails if the reading
   * leaves the name's row, parts from the age, or reserves that width again.
   */
  it("follows the name and the age on the name's own row, at its own width", async () => {
    const { container } = await renderWithRouter(
      <ResourceDetailHeader
        name="checkout-api-649f5449-h6x2v"
        kind="Pod"
        namespace="team-checkout"
        createdAt={new Date(Date.now() - 2 * 86_400_000).toISOString()}
        dataUpdatedAt={Date.now()}
        live
        onBack={() => {}}
      />
    );
    const heading = screen.getByRole("heading", {
      name: /checkout-api-649f5449-h6x2v/,
    });
    const reading = screen.getByText("live").closest("[data-header-reading]");
    expect(reading).not.toBeNull();
    expect(reading).toHaveTextContent(/2d old/);
    const row = heading.parentElement?.parentElement;
    expect(reading?.parentElement).toBe(row);
    expect(
      heading.parentElement!.compareDocumentPosition(reading!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(container.querySelector("[data-text]")).toBeNull();
  });
});
