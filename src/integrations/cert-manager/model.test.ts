import { describe, expect, it } from "vitest";

import { certificateRows, issuerRows, worstCertificateTone } from "./model";
import type { CustomResourceInfo } from "@/generated/types";

const DAY = 86_400_000;
const inDays = (days: number) =>
  new Date(Date.now() + days * DAY).toISOString();

let uids = 0;

function resource(over: Partial<CustomResourceInfo> = {}): CustomResourceInfo {
  return {
    name: "thing",
    namespace: "shop",
    uid: `uid-${++uids}`,
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    spec: {},
    status: null,
    labels: {},
    annotations: {},
    createdAt: null,
    ownerReferences: [],
    ...over,
  };
}

function certificate(over: {
  name?: string;
  namespace?: string;
  uid?: string;
  secretName?: string;
  issuer?: { name: string; kind?: string };
  dnsNames?: string[];
  ready?: boolean;
  issuing?: boolean;
  notAfter?: string | null;
  notBefore?: string;
  renewalTime?: string;
  readyMessage?: string;
  attempts?: number;
}): CustomResourceInfo {
  const conditions: Array<Record<string, string>> = [];
  if (over.ready !== undefined) {
    conditions.push({
      type: "Ready",
      status: over.ready ? "True" : "False",
      reason: over.ready ? "Ready" : "Failed",
      ...(over.readyMessage ? { message: over.readyMessage } : {}),
    });
  }
  if (over.issuing) {
    conditions.push({ type: "Issuing", status: "True", reason: "Renewing" });
  }
  return resource({
    name: over.name ?? "web-cert",
    namespace: over.namespace ?? "shop",
    uid: over.uid ?? `cert-${++uids}`,
    spec: {
      secretName: over.secretName ?? "web-tls",
      issuerRef: {
        name: over.issuer?.name ?? "letsencrypt",
        kind: over.issuer?.kind ?? "ClusterIssuer",
      },
      dnsNames: over.dnsNames ?? ["shop.example.com"],
    },
    status: {
      conditions,
      ...(over.notAfter === null
        ? {}
        : { notAfter: over.notAfter ?? inDays(60) }),
      ...(over.notBefore !== undefined ? { notBefore: over.notBefore } : {}),
      ...(over.renewalTime !== undefined
        ? { renewalTime: over.renewalTime }
        : {}),
      ...(over.attempts !== undefined
        ? { failedIssuanceAttempts: over.attempts }
        : {}),
    },
  });
}

const ownedBy = (uid: string, over: Partial<CustomResourceInfo> = {}) =>
  resource({
    ...over,
    ownerReferences: [
      {
        apiVersion: "cert-manager.io/v1",
        kind: "Certificate",
        name: "x",
        uid,
        controller: true,
      },
    ],
  });

describe("ordering by trouble", () => {
  /**
   * The whole reason this page is not alphabetical. A reader with one
   * certificate that never issued and thirty that are fine does not want to
   * scroll to `w`.
   */
  it("puts what cannot serve above what merely runs out", () => {
    const rows = certificateRows(
      [
        certificate({ name: "healthy", ready: true }),
        certificate({ name: "soon", ready: true, notAfter: inDays(5) }),
        certificate({ name: "never", ready: false, notAfter: null }),
        certificate({ name: "expired", ready: true, notAfter: inDays(-2) }),
        certificate({ name: "stuck", ready: false, notAfter: inDays(30) }),
      ],
      [],
      [],
      []
    );
    expect(rows.map((row) => row.name)).toEqual([
      "never",
      "expired",
      "stuck",
      "soon",
      "healthy",
    ]);
  });

  /**
   * A certificate whose Secret does not exist and one that is merely failing
   * to renew are different outages: the second is still serving traffic, and
   * calling both "broken" would send somebody to the wrong one first.
   */
  it("tells never-issued from failing-to-renew", () => {
    const [never] = certificateRows(
      [certificate({ ready: false, notAfter: null })],
      [],
      [],
      []
    );
    expect(never.neverIssued).toBe(true);
    expect(never.state).toEqual({ text: "never issued", tone: "err" });

    const [renewing] = certificateRows(
      [certificate({ ready: false, notAfter: inDays(20) })],
      [],
      [],
      []
    );
    expect(renewing.neverIssued).toBe(false);
    expect(renewing.state).toEqual({ text: "renewal failing", tone: "err" });
  });

  it("says nothing loud about a certificate that is simply serving", () => {
    const [row] = certificateRows(
      [certificate({ ready: true, notAfter: inDays(60) })],
      [],
      [],
      []
    );
    expect(row.state.tone).toBe("ok");
    expect(row.steps).toEqual([]);
  });

  /**
   * Would break if a seven-day certificate went back to wearing a warning
   * its whole life (#68). Its renewal is cert-manager's job, the plan is
   * still ahead, and the verdict states the plan.
   */
  it("trusts a short certificate that is renewing on schedule", () => {
    const [row] = certificateRows(
      [
        certificate({
          ready: true,
          notBefore: inDays(-4.75),
          notAfter: inDays(2.25),
          renewalTime: inDays(1.5),
        }),
      ],
      [],
      [],
      []
    );
    expect(row.state).toEqual({ text: "renews in 1 day", tone: "ok" });
  });

  /** Would break if a renewal cert-manager has quietly missed read as fine. */
  it("marks a certificate whose renewal time has come and gone", () => {
    const [row] = certificateRows(
      [
        certificate({
          ready: true,
          notBefore: inDays(-4.75),
          notAfter: inDays(2.25),
          renewalTime: inDays(-0.5),
        }),
      ],
      [],
      [],
      []
    );
    expect(row.state).toEqual({
      text: "renewal overdue — expires in 2 days",
      tone: "warn",
    });
  });
});

describe("worstCertificateTone", () => {
  /**
   * The sidebar dot's whole contract: silence while everything is on
   * schedule, however short the certificates' lives are.
   */
  it("stays quiet over certificates that are simply fine", () => {
    expect(
      worstCertificateTone([
        certificate({ ready: true, notAfter: inDays(60) }),
        certificate({
          ready: true,
          notBefore: inDays(-4.75),
          notAfter: inDays(2.25),
          renewalTime: inDays(1.5),
        }),
      ])
    ).toBeNull();
  });

  it("says warn for a renewal that has been missed", () => {
    expect(
      worstCertificateTone([
        certificate({ ready: true, notAfter: inDays(60) }),
        certificate({
          ready: true,
          notBefore: inDays(-4.75),
          notAfter: inDays(2.25),
          renewalTime: inDays(-0.5),
        }),
      ])
    ).toBe("warn");
  });

  /** Would break if a dead certificate could hide behind a merely late one. */
  it("says err once something cannot serve at all", () => {
    expect(
      worstCertificateTone([
        certificate({
          ready: true,
          notBefore: inDays(-4.75),
          notAfter: inDays(2.25),
          renewalTime: inDays(-0.5),
        }),
        certificate({ ready: false, notAfter: null }),
      ])
    ).toBe("err");
  });
});

describe("the walk", () => {
  /**
   * The one thing cert-manager knows that nothing else does. Would break if
   * the deepest object's own sentence stopped reaching the surface — the
   * Certificate's `Ready` message says "waiting for the order", and the
   * Challenge says what actually failed.
   */
  it("follows Certificate to Challenge and keeps the deepest message", () => {
    const cert = certificate({
      uid: "cert-1",
      ready: false,
      notAfter: inDays(9),
      readyMessage: "Issuing certificate as Secret was previously issued",
    });
    const request = ownedBy("cert-1", {
      uid: "req-1",
      kind: "CertificateRequest",
      name: "web-cert-1",
    });
    const order = ownedBy("req-1", {
      uid: "order-1",
      kind: "Order",
      name: "web-cert-1-42",
      status: { state: "pending" },
    });
    const challenge = ownedBy("order-1", {
      uid: "chal-1",
      kind: "Challenge",
      name: "web-cert-1-42-0",
      spec: { type: "HTTP-01", dnsName: "shop.example.com" },
      status: {
        state: "invalid",
        reason:
          "Waiting for HTTP-01 challenge propagation: wrong status code '404'",
      },
    });

    const [row] = certificateRows([cert], [request], [order], [challenge]);
    expect(row.steps.map((step) => step.kind)).toEqual([
      "Certificate",
      "CertificateRequest",
      "Order",
      "Challenge",
    ]);
    expect(row.steps[3].failed).toBe(true);
    expect(row.failure).toContain("wrong status code '404'");
  });

  /**
   * Would break on a certificate that has failed four times: three of its
   * requests are history, and reporting the oldest would show a failure that
   * was fixed a week ago.
   */
  it("walks the newest request, not the first one it finds", () => {
    const cert = certificate({
      uid: "cert-1",
      ready: false,
      notAfter: inDays(9),
    });
    const old = ownedBy("cert-1", {
      uid: "req-old",
      name: "old",
      annotations: { "cert-manager.io/certificate-revision": "1" },
    });
    const fresh = ownedBy("cert-1", {
      uid: "req-new",
      name: "new",
      annotations: { "cert-manager.io/certificate-revision": "4" },
    });

    const [row] = certificateRows([cert], [old, fresh], [], []);
    expect(row.steps[1].name).toBe("new");
  });

  it("stops at the point nothing has been requested yet", () => {
    const cert = certificate({ uid: "cert-1", ready: false, notAfter: null });
    const [row] = certificateRows([cert], [], [], []);
    expect(row.steps.map((step) => step.kind)).toEqual(["Certificate"]);
  });
});

describe("issuers", () => {
  const issuer = (
    name: string,
    over: { namespace?: string; ready?: boolean; spec?: unknown } = {}
  ) =>
    resource({
      name,
      namespace: over.namespace ?? "shop",
      kind: "Issuer",
      spec: over.spec ?? {
        acme: { server: "https://acme-v02.api.letsencrypt.org/directory" },
      },
      status: {
        conditions: [
          {
            type: "Ready",
            status: over.ready === false ? "False" : "True",
            message:
              over.ready === false
                ? "Failed to register ACME account"
                : undefined,
          },
        ],
      },
    });

  it("names Let's Encrypt rather than repeating its URL", () => {
    const [row] = issuerRows([], [issuer("letsencrypt")], []);
    expect(row.type).toBe("ACME");
    expect(row.detail).toBe("Let's Encrypt");
  });

  /**
   * The one difference between the two kinds, and the reason a Certificate
   * naming `Issuer/letsencrypt` from the wrong namespace never issues: an
   * Issuer is matched by name *and* namespace, a ClusterIssuer by name alone.
   */
  it("counts what each issuer signs, with the namespace rule", () => {
    const certs = certificateRows(
      [
        certificate({
          namespace: "shop",
          issuer: { name: "le", kind: "Issuer" },
        }),
        certificate({
          namespace: "other",
          issuer: { name: "le", kind: "Issuer" },
        }),
      ],
      [],
      [],
      []
    );
    const [row] = issuerRows([issuer("le", { namespace: "shop" })], [], certs);
    expect(row.serves).toBe(1);
  });

  it("puts a refusing issuer first and keeps its message", () => {
    const rows = issuerRows(
      [issuer("good"), issuer("bad", { ready: false })],
      [],
      []
    );
    expect(rows[0].name).toBe("bad");
    expect(rows[0].message).toBe("Failed to register ACME account");
    expect(rows[1].message).toBeNull();
  });
});
