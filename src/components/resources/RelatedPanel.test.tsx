/**
 * The two sentences this panel exists to keep apart.
 *
 * "This object points at nothing" is a fact about somebody's cluster. "No
 * integration in this app reads this kind" is an admission about the app.
 * Drawn the same way, a reader believes the first one — and on a `SealedSecret`
 * or a `ServiceMonitor`, which is most CRDs on most clusters, the first one is
 * the app inventing a claim it never checked.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { RelatedPanel } from "./RelatedPanel";
import type { RelatedObjects } from "@/hooks/useRelatedObjects";

const query = (over: Partial<RelatedObjects> = {}): RelatedObjects => ({
  claimed: false,
  related: [],
  isPending: false,
  error: null,
  ...over,
});

const draw = (over: Partial<RelatedObjects> = {}, kind = "SealedSecret") =>
  render(
    <MemoryRouter>
      <RelatedPanel query={query(over)} kind={kind} />
    </MemoryRouter>
  );

describe("a custom resource's connections", () => {
  it("says the app does not know, when no integration claims the kind", () => {
    draw();
    expect(
      screen.getByText(/No integration in this app reads SealedSecret/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/gap in the app and not a fact about the cluster/)
    ).toBeInTheDocument();
  });

  it("says the object points at nothing, when one claims it and finds none", () => {
    draw({ claimed: true }, "Application");
    expect(
      screen.getByText(/names no other object right now/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/No integration in this app/)).toBeNull();
  });

  /**
   * The third state, and the one most likely to mislead: an owner reference
   * is drawn for every object whether or not anything understands the kind,
   * so a list of exactly one row must not read as the whole answer.
   */
  it("marks an owner-only list as short, not as complete", () => {
    draw({
      claimed: false,
      related: [
        {
          relation: "controlled by",
          kind: "HelmRelease",
          name: "sealed-secrets",
          namespace: "kube-system",
          group: "helm.toolkit.fluxcd.io",
        },
      ],
    });
    expect(screen.getByText("controlled by")).toBeInTheDocument();
    expect(
      screen.getByText(/Only the owner reference, which every object carries/)
    ).toBeInTheDocument();
  });

  it("says nothing of the sort once an integration has answered", () => {
    draw(
      {
        claimed: true,
        related: [
          {
            relation: "manages",
            kind: "Deployment",
            name: "api",
            namespace: "shop",
            group: "apps",
          },
        ],
      },
      "Application"
    );
    expect(screen.queryByText(/Only the owner reference/)).toBeNull();
    expect(screen.queryByText(/No integration in this app/)).toBeNull();
  });

  /** A row whose CRD is known is openable; one without it is still readable. */
  it("opens a far end that is itself a custom resource", () => {
    draw({
      claimed: true,
      related: [
        {
          relation: "manages",
          kind: "Certificate",
          name: "shop-tls",
          namespace: "shop",
          group: "cert-manager.io",
          crd: "certificates.cert-manager.io",
        },
      ],
    });
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "/customresourcedefinitions/certificates.cert-manager.io/instances/shop/shop-tls"
    );
  });

  /**
   * The controller's own sentence, drawn as written. A paraphrase of somebody
   * else's failure is a second guess at it, and this string is what the reader
   * pastes into a search.
   */
  it("repeats the controller's message verbatim", () => {
    draw({
      claimed: true,
      related: [
        {
          relation: "manages",
          kind: "Deployment",
          name: "api",
          namespace: "shop",
          group: "apps",
          note: 'admission webhook "vpa.k8s.io" denied the request',
          tone: "err",
        },
      ],
    });
    expect(
      screen.getByText('admission webhook "vpa.k8s.io" denied the request')
    ).toBeInTheDocument();
  });

  it("warns that a failed integration leaves the list short", () => {
    draw({ claimed: true, error: new Error("connection refused") });
    expect(screen.getByText(/short by an unknown amount/)).toBeInTheDocument();
  });
});
