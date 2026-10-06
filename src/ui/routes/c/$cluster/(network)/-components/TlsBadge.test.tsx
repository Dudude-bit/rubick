import { afterEach, describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TooltipProvider } from "@/components/ui/tooltip";
import { TlsBadge } from "./TlsBadge";
import { useLocaleStore } from "@/stores/localeStore";

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
  afterEach(() => useLocaleStore.setState({ choice: null }));

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
    const tip = await tooltipOf("1 host");
    expect(tip).toContain("api.other.io · TLS not checked");
    expect(tip).not.toContain("shop.example.com · TLS not checked");
  });

  /** A catch-all certificate serves every host, so none is left unchecked. */
  it("leaves no host unchecked under a catch-all certificate", async () => {
    badge(["www.example.com"], ["api.other.io"], true);
    const tip = await tooltipOf("every host");
    expect(tip).toContain("catch-all certificate");
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
    const some = screen.getByText("1 host").className;
    expect(notChecked).not.toBe(none);
    expect(notChecked).not.toBe(some);
  });

  /**
   * Lena read "TLS 1" as a protocol version. Fails if the count stops
   * naming hosts in the reader's language, or the catch-all goes English.
   */
  it("counts hosts in Russian, not a bare TLS number", () => {
    useLocaleStore.setState({ choice: "ru" });
    badge(["a.example.com", "b.example.com"], []);
    expect(screen.getByText("2 хоста")).toBeTruthy();
    badge(["a.example.com"], [], true);
    expect(screen.getByText("все хосты")).toBeTruthy();
    expect(screen.queryByText(/^TLS \d/)).toBeNull();
  });

  it("says no TLS once everything answered and nothing covers it", () => {
    badge([], []);
    expect(screen.getByText("no TLS")).toBeTruthy();
  });
});
