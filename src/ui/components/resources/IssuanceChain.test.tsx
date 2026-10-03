import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { IssuanceSection } from "./IssuanceChain";
import type { Issuance } from "@/hooks/useCertificateIssuance";
import type { IssuanceStory } from "@/generated/types";

const story = (over: Partial<IssuanceStory> = {}): IssuanceStory => ({
  certificate: "shop-tls",
  namespace: "k8s-gui-test",
  issuer: "letsencrypt-prod",
  issuerKind: "ClusterIssuer",
  dnsNames: ["shop.k8s-gui.test"],
  renewalTime: null,
  inFlight: false,
  failure: null,
  stalled: null,
  since: null,
  attempts: null,
  steps: [],
  ...over,
});

const answered = (over: Partial<Issuance> = {}): Issuance => ({
  available: true,
  stories: new Map(),
  error: null,
  ...over,
});

describe("IssuanceSection", () => {
  /**
   * Would break if the app started needing an extension to read correctly.
   * Most clusters have no cert-manager, and on those the page owes the same
   * answer it gave before this feature existed — the certificate's own
   * facts, drawn above this, and not one word of apology here.
   */
  it("draws nothing at all when no extension can answer", () => {
    const { container } = render(
      <IssuanceSection
        issuance={{ available: false, stories: new Map(), error: null }}
        secretName="shop-tls"
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  /**
   * Would break if an extension that is installed but not answering looked
   * identical to one that was never installed. That is the trap: the reader
   * concludes the feature is broken rather than that their cluster is.
   */
  it("says so when the extension is there and did not answer", () => {
    render(
      <IssuanceSection
        issuance={answered({ error: new Error("connection refused") })}
        secretName="shop-tls"
      />
    );
    expect(screen.getByText(/connection refused/)).toBeInTheDocument();
    // And the core answer above is still claimed as read.
    expect(screen.getByText(/read from the Secret/)).toBeInTheDocument();
  });

  /**
   * Would break if a certificate that is simply renewing fine started
   * costing four hops. The walk exists for the one that did not; drawn on
   * every healthy certificate it stops being read before it is needed.
   */
  it("spends one line on a certificate that is not in trouble", () => {
    render(
      <IssuanceSection
        issuance={answered({
          stories: new Map([
            ["shop-tls", story({ renewalTime: "2999-01-01T00:00:00Z" })],
          ]),
        })}
        secretName="shop-tls"
      />
    );
    expect(screen.getByText(/Renewed automatically by/)).toBeInTheDocument();
    expect(screen.queryByText("CertificateRequest")).not.toBeInTheDocument();
  });

  /**
   * Would break if the walk stopped ending on the sentence that says what
   * failed. Four objects deep is exactly the cost this feature exists to
   * remove, and the last line is the whole product.
   */
  it("ends the walk on the reason", () => {
    render(
      <IssuanceSection
        issuance={answered({
          stories: new Map([
            [
              "shop-tls",
              story({
                inFlight: true,
                failure: "wrong status code '404', expected '200'",
                steps: [
                  {
                    kind: "Certificate",
                    name: "shop-tls",
                    state: "Renewing",
                    note: null,
                    failed: false,
                  },
                  {
                    kind: "Challenge",
                    name: "shop-tls-1-1948-394",
                    state: "invalid",
                    note: {
                      says: "challengeOn",
                      kind: "http-01",
                      domain: "shop.k8s-gui.test",
                    },
                    failed: true,
                  },
                ],
              }),
            ],
          ]),
        })}
        secretName="shop-tls"
      />
    );
    expect(screen.getByText("shop-tls-1-1948-394")).toBeInTheDocument();
    expect(
      screen.getByText("wrong status code '404', expected '200'")
    ).toBeInTheDocument();
  });

  /**
   * Would break if an unmanaged certificate were drawn as a failure. Most
   * TLS Secrets in most clusters were put there by hand, and saying so is a
   * checked claim rather than an absence of data.
   */
  it("names an unmanaged certificate as unmanaged", () => {
    render(
      <IssuanceSection
        issuance={answered({ stories: new Map([["shop-tls", null]]) })}
        secretName="shop-tls"
      />
    );
    expect(
      screen.getByText(/Nothing in this namespace manages this Secret/)
    ).toBeInTheDocument();
  });
});
