import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TooltipProvider } from "@/components/ui/tooltip";
import { TlsBadge } from "./TlsBadge";

const badge = (
  tlsHosts: string[],
  unchecked: string[],
  hasCatchAllTls = false
) =>
  render(
    <TooltipProvider>
      <TlsBadge
        tlsHosts={tlsHosts}
        hasCatchAllTls={hasCatchAllTls}
        vendor={{ hosts: [], by: "", unchecked }}
      />
    </TooltipProvider>
  );

/** What the tooltip lists once the pointer is on the cell. */
async function tooltipOf(label: string): Promise<string> {
  await userEvent.hover(screen.getByText(label));
  const tips = await screen.findAllByRole("tooltip");
  return tips.map((tip) => tip.textContent).join("\n");
}

describe("the Ingress list's TLS cell", () => {
  /**
   * A GKE Ingress whose ManagedCertificate could not be read has nothing in
   * `spec.tls`, and the cell said "no TLS" about a host served over HTTPS.
   * Fails if the unchecked hosts are ignored.
   */
  it("says TLS was not checked for a host the controller could not tell about", () => {
    badge([], ["shop.example.com"]);
    expect(screen.getByText("TLS not checked")).toBeTruthy();
    expect(screen.queryByText("no TLS")).toBeNull();
  });

  /**
   * `spec.tls` naming the host is the end of the question. The unchecked
   * hosts only ever reach the tooltip, so a label-only assertion passed with
   * the covered host listed there as "TLS not checked".
   */
  it("counts a host spec.tls covers whatever the controller said", async () => {
    badge(["*.example.com"], ["shop.example.com", "api.other.io"]);
    const tip = await tooltipOf("TLS 1");
    expect(tip).toContain("api.other.io · TLS not checked");
    expect(tip).not.toContain("shop.example.com · TLS not checked");
  });

  /** A catch-all certificate serves every host, so none is left unchecked. */
  it("leaves no host unchecked under a catch-all certificate", async () => {
    badge(["www.example.com"], ["api.other.io"], true);
    const tip = await tooltipOf("TLS 1 + all");
    expect(tip).toContain("+ catch-all certificate");
    expect(tip).not.toContain("TLS not checked");
  });

  /**
   * The words differed and the colour did not, so down a list of Ingresses
   * "the controller did not answer" looked exactly like "no TLS".
   */
  it("does not colour an unchecked host like one with TLS or one without", () => {
    badge([], ["shop.example.com"]);
    const notChecked = screen.getByText("TLS not checked").className;
    badge([], []);
    const none = screen.getByText("no TLS").className;
    badge(["shop.example.com"], []);
    const some = screen.getByText("TLS 1").className;
    expect(notChecked).not.toBe(none);
    expect(notChecked).not.toBe(some);
  });

  it("says no TLS once everything answered and nothing covers it", () => {
    badge([], []);
    expect(screen.getByText("no TLS")).toBeTruthy();
  });
});
