import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { TlsBadge } from "./TlsBadge";

const badge = (tlsHosts: string[], unchecked: string[]) =>
  render(
    <TooltipProvider>
      <TlsBadge
        tlsHosts={tlsHosts}
        hasCatchAllTls={false}
        vendor={{ hosts: [], by: "", unchecked }}
      />
    </TooltipProvider>
  );

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

  /** `spec.tls` naming the host is the end of the question. */
  it("counts a host spec.tls covers whatever the controller said", () => {
    badge(["*.example.com"], ["shop.example.com"]);
    expect(screen.getByText("TLS 1")).toBeTruthy();
    expect(screen.queryByText("TLS not checked")).toBeNull();
  });

  it("says no TLS once everything answered and nothing covers it", () => {
    badge([], []);
    expect(screen.getByText("no TLS")).toBeTruthy();
  });
});
