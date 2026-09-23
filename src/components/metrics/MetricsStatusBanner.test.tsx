import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";

import { renderWithProviders } from "@/test/render";
import { MetricsStatusBanner } from "./MetricsStatusBanner";

const available = { status: "available" as const, message: null };

describe("MetricsStatusBanner", () => {
  /**
   * One namespace of a selection refused beside one that answered leaves the
   * status "available". Without the unread namespace named, its pods' blank
   * samples looked like "not scraped yet" and no banner said otherwise.
   */
  it("names a namespace whose metrics were refused beside ones that answered", () => {
    renderWithProviders(
      <MetricsStatusBanner
        status={available}
        unread={[
          {
            namespace: "staging",
            code: "PERMISSION_DENIED",
            message:
              'pods.metrics.k8s.io is forbidden in the namespace "staging"',
          },
        ]}
      />
    );
    expect(
      screen.getByText("Could not read pod metrics in staging.")
    ).toBeInTheDocument();
  });

  /** Every namespace answered: there is nothing to say. */
  it("says nothing when every namespace answered", () => {
    const { container } = renderWithProviders(
      <MetricsStatusBanner status={available} unread={[]} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
