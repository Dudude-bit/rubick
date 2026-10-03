import { describe, expect, it } from "vitest";

import type { IngressInfo } from "@/generated/types";
import type { IngressTls } from "@/integrations";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { ingressOpenUrl, vendorTlsAnswer } from "./vendor-tls";

const t = ((section, key, values) =>
  translate("en", section, key, values)) as T;

const shop = {
  name: "shop",
  namespace: "web",
  rules: [{ host: "shop.example.com", paths: [] }],
  loadBalancerIps: ["34.1.2.3"],
  tlsHosts: [],
  hasCatchAllTls: false,
} as unknown as IngressInfo;

const answering = (
  terminated: IngressTls["terminated"] | undefined,
  read: { isPending?: boolean; error?: Error | null } = {}
) => ({
  of: () =>
    terminated === undefined
      ? null
      : {
          host: "shop.example.com",
          terminated,
          by: { key: "verbatimLine" as const, values: { said: "shop-cert" } },
        },
  isPending: read.isPending ?? false,
  error: read.error ?? null,
});

describe("what the Ingress list takes from a cloud controller", () => {
  /**
   * The list kept only the hosts a controller terminates, so one that could
   * not read its certificate left the row to `spec.tls` and "no TLS". Fails
   * if a `null` answer is dropped.
   */
  it("keeps a host the controller could not tell about apart", () => {
    expect(vendorTlsAnswer(shop, answering(null), t)?.unchecked).toEqual([
      "shop.example.com",
    ]);
  });

  /** A question that failed has not said no either. */
  it("keeps a host apart while the controllers could not be asked", () => {
    const failed = answering(undefined, { error: new Error("x") });
    expect(vendorTlsAnswer(shop, failed, t)?.unchecked).toEqual([
      "shop.example.com",
    ]);
  });

  /**
   * A question still out has not said no. Without it the host counted as
   * answered while the controllers were being asked, and the row offered
   * `http://` for a site that may well be HTTPS.
   */
  it("keeps a host apart while the controllers have not answered yet", () => {
    const pending = answering(undefined, { isPending: true });
    expect(vendorTlsAnswer(shop, pending, t)?.unchecked).toEqual([
      "shop.example.com",
    ]);
    expect(ingressOpenUrl(shop, vendorTlsAnswer(shop, pending, t))).toBeNull();
  });

  /**
   * Two rules for one host are still one host: counted twice it read
   * "TLS 2" and keyed two tooltip rows alike.
   */
  it("names a host two rules share once", () => {
    const twice = {
      ...shop,
      rules: [
        { host: "shop.example.com", paths: [] },
        { host: "shop.example.com", paths: [] },
      ],
    } as IngressInfo;
    expect(vendorTlsAnswer(twice, answering(true), t)?.hosts).toEqual([
      "shop.example.com",
    ]);
    expect(vendorTlsAnswer(twice, answering(null), t)?.unchecked).toEqual([
      "shop.example.com",
    ]);
  });

  /** Everything answered and nobody speaking for the Ingress is spec.tls's call. */
  it("says nothing when every controller answered and none owns it", () => {
    expect(vendorTlsAnswer(shop, answering(undefined), t)).toBeNull();
  });

  /**
   * "Open in browser" built `http://` for a host whose scheme nobody could
   * read, the link CLAUDE.md says a consumer must not offer. Fails if the
   * unknown scheme falls through to http.
   */
  it("offers no link for a host whose scheme is not known", () => {
    const vendor = vendorTlsAnswer(shop, answering(null), t);
    expect(ingressOpenUrl(shop, vendor)).toBeNull();
    expect(
      ingressOpenUrl(shop, vendorTlsAnswer(shop, answering(true), t))
    ).toBe("https://shop.example.com");
    expect(
      ingressOpenUrl(shop, vendorTlsAnswer(shop, answering(false), t))
    ).toBe("http://shop.example.com");
  });

  /**
   * `spec.tls` naming the host settles the scheme whatever the controller
   * could not tell; the link went missing when its silence outranked it.
   */
  it("offers https for a host spec.tls covers though the controller could not tell", () => {
    const covered = { ...shop, tlsHosts: ["*.example.com"] } as IngressInfo;
    expect(
      ingressOpenUrl(covered, vendorTlsAnswer(covered, answering(null), t))
    ).toBe("https://shop.example.com");
  });
});
