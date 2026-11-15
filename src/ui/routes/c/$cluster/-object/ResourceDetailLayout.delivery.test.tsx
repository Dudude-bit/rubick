import { describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";
import { Info } from "lucide-react";

import { viewGlyph } from "@/components/object/detail-tab";
import { renderWithRouter } from "@/test/render";
import type { Delivery } from "@/integrations";
import { ResourceDetailLayout } from "./ResourceDetailLayout";

const claim = {
  state: "claimed",
  vendor: "Argo CD",
  vendorId: "argocd",
  claim: "shop",
  ownerKind: "Application",
  owner: null,
} as Delivery;

vi.mock("../-delivery/useDelivery", () => ({
  useDelivery: () => ({ deliveries: [claim] }),
}));

describe("ResourceDetailLayout delivery line", () => {
  /** What is wrong with the object leads the page; the delivery card follows the cause and findings, above the strip. */
  it("draws the delivery card after the cause and before the tab strip", async () => {
    await renderWithRouter(
      <ResourceDetailLayout
        resource={{ name: "api" }}
        title="api"
        resourceKind="Deployment"
        isLoading={false}
        error={null}
        onBack={() => {}}
        onTabChange={() => {}}
        activeTab="overview"
        summary={<p>no pod is running</p>}
        tabs={[
          {
            id: "overview",
            label: "Overview",
            glyph: viewGlyph(Info),
            content: null,
          },
        ]}
      />,
      { at: "/c/prod/deployments/api", route: "/c/$cluster/$" }
    );
    const cause = screen.getByText("no pod is running");
    const card = screen.getByText(/Labelled as delivered by shop/);
    const strip = screen.getByRole("tablist");
    expect(
      cause.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      card.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
