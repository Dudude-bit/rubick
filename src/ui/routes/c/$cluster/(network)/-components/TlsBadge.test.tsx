import { afterEach, describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { IngressInfo } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { IngressTls } from "@/integrations";
import { TlsBadge } from "./TlsBadge";
import { ingressTlsVerdict, vendorTlsAnswer } from "../../-object/vendor-tls";
import type { TlsUnread } from "@/lib/ingress-tls";
import { useLocaleStore } from "@/stores/localeStore";

const t = ((section, key, values) =>
  translate("en", section, key, values)) as T;

/** The cell as the list draws it: the controllers' answer read through `vendorTlsAnswer`. */
const badge = (
  tlsHosts: string[],
  unchecked: string[],
  hasCatchAllTls = false,
  said: Pick<IngressTls, "terminated" | "replacesSpec" | "by"> | null = null,
  unread: TlsUnread = false,
  error: Error | null = null
) => {
  const hosts = [...new Set([...tlsHosts, ...unchecked])];
  const ingress = {
    name: "shop",
    namespace: "web",
    rules: hosts.map((host) => ({ host, paths: [] })),
    tlsHosts,
    tlsConfigs:
      tlsHosts.length > 0 || hasCatchAllTls
        ? [{ hosts: tlsHosts, secretName: "shop-tls" }]
        : [],
    hasCatchAllTls,
  } as unknown as IngressInfo;
  const vendor = vendorTlsAnswer(
    ingress,
    {
      of: (_, host) =>
        said
          ? { host, ...said }
          : unchecked.includes(host)
            ? { host, terminated: null, by: { key: "awsHttpOnly" } }
            : null,
      unread,
      error,
    },
    t
  );
  return render(
    <TooltipProvider>
      <TlsBadge
        tlsHosts={tlsHosts}
        hasCatchAllTls={hasCatchAllTls}
        vendor={vendor}
        tls={ingressTlsVerdict(ingress, vendor, unread)}
      />
    </TooltipProvider>
  );
};

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
   * The cell said "TLS not checked" and nothing of why, so a read the
   * cluster refused for good looked like one still on its way.
   */
  it("says why TLS was not checked where the controller said why", async () => {
    badge([], ["shop.example.com"], false, {
      terminated: null,
      by: { key: "verbatimLine", values: { said: "ingresses is forbidden" } },
    });
    expect(await tooltipOf("TLS not checked")).toContain(
      "ingresses is forbidden"
    );
  });

  /**
   * For a controller that only adds to `spec.tls`, the field naming the host
   * is the end of the question. The unchecked hosts only ever reach the
   * tooltip, so a label-only assertion passed with the covered host listed
   * there as "TLS not checked".
   */
  it("counts a host spec.tls covers whatever the controller said", async () => {
    badge(["*.example.com"], ["shop.example.com", "api.other.io"]);
    const tip = await tooltipOf("1 host");
    expect(tip).toContain("api.other.io · TLS not checked");
    expect(tip).not.toContain("shop.example.com · TLS not checked");
  });

  /**
   * The cell counted `spec.tls` alone beside a tooltip naming the host the
   * load balancer holds a certificate for too, while the page counted both.
   */
  it("counts a host the load balancer holds beside the ones spec.tls names", () => {
    render(
      <TooltipProvider>
        <TlsBadge
          tlsHosts={["shop.example.com"]}
          hasCatchAllTls={false}
          vendor={{
            hosts: ["api.example.com"],
            by: "the load balancer",
            unchecked: [],
            plain: [],
            plainWhy: null,
            uncheckedWhy: null,
          }}
          tls="yes"
        />
      </TooltipProvider>
    );
    expect(screen.getByText("2 hosts")).toBeTruthy();
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

  /**
   * Traefik reads `spec.tls` for certificates only. The cell counted the host
   * as TLS while every request to it went over plain HTTP, and said nothing
   * of why the certificate written there does nothing.
   */
  it("says no TLS, and why, for a host its controller serves plain despite spec.tls", async () => {
    badge(["promo.example.com"], [], false, {
      terminated: false,
      replacesSpec: true,
      by: { key: "traefikTlsNotServed" },
    });
    expect(screen.queryByText("1 host")).toBeNull();
    const tip = await tooltipOf("no TLS");
    expect(tip).toContain("router.tls");
  });

  /**
   * Traefik's answer replaces `spec.tls`, and while it was out or had failed
   * the page said "TLS not checked" and the cell beside it "1 host", the
   * words a confirmed host gets. Fails if the cell counts a host, or calls a
   * catch-all certificate TLS on every host, where the page's own verdict is
   * that nobody could tell, or keeps the reason out of reach.
   */
  it("says TLS was not checked, as the page does, while the controller that replaces spec.tls is unread", async () => {
    const first = badge(["shop.example.com"], [], false, null, "replaces");
    expect(screen.getByText("TLS not checked")).toBeTruthy();
    expect(screen.queryByText("1 host")).toBeNull();
    first.unmount();

    const every = badge(["shop.example.com"], [], true, null, "replaces");
    expect(screen.getByText("TLS not checked")).toBeTruthy();
    expect(screen.queryByText("every host")).toBeNull();
    every.unmount();

    badge(
      ["shop.example.com"],
      [],
      false,
      null,
      "replaces",
      new Error("ingressclasses is forbidden")
    );
    expect(await tooltipOf("TLS not checked")).toContain(
      "ingressclasses is forbidden"
    );
  });

  /** Without `replacesSpec` a controller's "no" never outvotes spec.tls. */
  it("keeps spec.tls over a controller that does not replace it", () => {
    badge(["shop.example.com"], [], false, {
      terminated: false,
      by: { key: "awsHttpOnly" },
    });
    expect(screen.getByText("1 host")).toBeTruthy();
  });

  it("says no TLS once everything answered and nothing covers it", () => {
    badge([], []);
    expect(screen.getByText("no TLS")).toBeTruthy();
  });
});
