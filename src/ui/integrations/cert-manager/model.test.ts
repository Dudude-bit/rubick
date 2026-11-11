import { describe, expect, it } from "vite-plus/test";

import {
  acmeServerLabel,
  attemptFailed,
  certificateRows,
  issuerRows,
  worstCertificateTone,
} from "./model";
import type { CustomResourceInfo } from "@/generated/types";
import { conditionRole } from "@/lib/condition-health";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

/** The English catalogue — what these expectations are written in. */
const t: T = (section, key, values) => translate("en", section, key, values);

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
    generation: null,
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
  /** Issuing=False, as the issuing controller leaves it after an attempt. */
  attempt?: { reason: string; message: string };
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
  if (over.attempt) {
    conditions.push({ type: "Issuing", status: "False", ...over.attempt });
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
      [],
      t
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
   * Would break if the rows ranked by whole days: two certificates expiring
   * today tie there and fall back to the alphabet, so the one with two hours
   * left could sit under the one with twenty — in the hour the order is the
   * only thing the page is for.
   */
  it("ranks certificates expiring today by the hour, not the alphabet", () => {
    const rows = certificateRows(
      [
        certificate({
          name: "alpha",
          ready: true,
          notBefore: inDays(-6.4),
          notAfter: inDays(0.6),
        }),
        certificate({
          name: "omega",
          ready: true,
          notBefore: inDays(-6.8),
          notAfter: inDays(0.2),
        }),
      ],
      [],
      [],
      [],
      t
    );
    expect(rows.map((row) => row.name)).toEqual(["omega", "alpha"]);
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
      [],
      t
    );
    expect(never.neverIssued).toBe(true);
    expect(never.state).toEqual({ text: "never issued", tone: "err" });

    const [renewing] = certificateRows(
      [certificate({ ready: false, notAfter: inDays(20) })],
      [],
      [],
      [],
      t
    );
    expect(renewing.neverIssued).toBe(false);
    expect(renewing.state).toEqual({ text: "renewal failing", tone: "err" });
  });

  /**
   * cert-manager writes a Certificate's Ready as True or False, so one it
   * has not written is cert-manager not having looked: restored from a
   * backup, every Certificate read "never issued" over a Secret that was
   * serving. Fails if its silence reads as a refusal again.
   */
  it("does not call a Certificate cert-manager has not answered about never issued", () => {
    const silent = certificate({ notAfter: null });
    const [unwritten] = certificateRows([silent], [], [], [], t);
    expect(unwritten.ready).toBeNull();
    expect(unwritten.neverIssued).toBe(false);
    expect(unwritten.state).toEqual({ text: "no status yet", tone: "warn" });
    expect(unwritten.steps).toEqual([]);
    expect(worstCertificateTone([silent])).toBe("warn");

    const [unknown] = certificateRows(
      [
        resource({
          status: {
            conditions: [{ type: "Ready", status: "Unknown" }],
            notAfter: inDays(60),
          },
        }),
      ],
      [],
      [],
      [],
      t
    );
    expect(unknown.state).toEqual({ text: "no status yet", tone: "warn" });
  });

  it("says nothing loud about a certificate that is simply serving", () => {
    const [row] = certificateRows(
      [certificate({ ready: true, notAfter: inDays(60) })],
      [],
      [],
      [],
      t
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
      [],
      t
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
      [],
      t
    );
    expect(row.state).toEqual({
      text: "renewal overdue: expires in 2 days",
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

    const [row] = certificateRows([cert], [request], [order], [challenge], t);
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

    const [row] = certificateRows([cert], [old, fresh], [], [], t);
    expect(row.steps[1].name).toBe("new");
  });

  it("stops at the point nothing has been requested yet", () => {
    const cert = certificate({ uid: "cert-1", ready: false, notAfter: null });
    const [row] = certificateRows([cert], [], [], [], t);
    expect(row.steps.map((step) => step.kind)).toEqual(["Certificate"]);
  });
});

describe("a renewal under way", () => {
  const renewing = () =>
    certificate({
      uid: "cert-r",
      ready: true,
      issuing: true,
      notAfter: inDays(60),
      readyMessage: "Certificate is up to date and has not expired",
    });
  const request = (reason: string, message?: string) =>
    ownedBy("cert-r", {
      uid: "req-r",
      kind: "CertificateRequest",
      name: "web-cert-2",
      status: {
        conditions: [
          {
            type: "Ready",
            status: "False",
            reason,
            ...(message && { message }),
          },
        ],
      },
    });

  /**
   * For the whole of a renewal cert-manager keeps Ready=True with its usual
   * message and sets Issuing=True, and the request under it says it is
   * waiting. Either sentence made the row "renewal failing" in red, with
   * "Certificate is up to date" quoted as the failure. Fails if progress
   * reads as a failure again.
   */
  it("is renewing, not failing, while nothing on the walk has failed", () => {
    const [alone] = certificateRows([renewing()], [], [], [], t);
    expect(alone.state).toEqual({ text: "renewing", tone: "warn" });
    expect(alone.failure).toBeNull();

    const [waiting] = certificateRows(
      [renewing()],
      [request("Pending", "Waiting on certificate issuance from order")],
      [],
      [],
      t
    );
    expect(waiting.state).toEqual({ text: "renewing", tone: "warn" });
    expect(waiting.failure).toBeNull();
    expect(waiting.steps[1].note).toContain("Waiting on certificate issuance");
  });

  /** The other half: once a step has failed it is failing, in that step's words. */
  it("is failing once a step of the walk has failed", () => {
    const [row] = certificateRows(
      [renewing()],
      [request("Failed", "The certificate request has failed to complete")],
      [],
      [],
      t
    );
    expect(row.state).toEqual({ text: "renewal failing", tone: "err" });
    expect(row.failure).toBe("The certificate request has failed to complete");

    // A failed step with nothing to say does not borrow Ready=True's sentence.
    const [mute] = certificateRows(
      [renewing()],
      [request("Failed")],
      [],
      [],
      t
    );
    expect(mute.state.text).toBe("renewal failing");
    expect(mute.failure).toBeNull();
  });
});

describe("a renewal cert-manager has marked failed", () => {
  const RETRIED =
    "The certificate request has failed to complete and will be retried: ";
  const failedAttempt = () =>
    certificate({
      uid: "cert-f",
      ready: true,
      readyMessage: "Certificate is up to date and has not expired",
      notAfter: inDays(60),
      attempts: 2,
      attempt: { reason: "Failed", message: `${RETRIED}order is invalid` },
    });

  /**
   * When a request fails, cert-manager sets Issuing=False with the request's
   * reason and backs off for up to 32 hours, Ready still True. The row
   * walked only while Issuing was True, so for that whole wait it read as
   * fine. Fails if the walk or the verdict stops at Issuing=True again.
   */
  it("is failing through the backoff, in the failed request's words", () => {
    const request = ownedBy("cert-f", {
      uid: "req-f",
      kind: "CertificateRequest",
      name: "web-cert-3",
      status: {
        conditions: [
          {
            type: "Ready",
            status: "False",
            reason: "Failed",
            message: "Failed to wait for order resource to become ready",
          },
        ],
      },
    });
    const [row] = certificateRows([failedAttempt()], [request], [], [], t);
    expect(row.state).toEqual({ text: "renewal failing", tone: "err" });
    expect(
      row.steps.map((step) => [step.kind, step.state, step.failed])
    ).toEqual([
      ["Certificate", "Failed", true],
      ["CertificateRequest", "Failed", true],
    ]);
    expect(row.failure).toBe(
      "Failed to wait for order resource to become ready"
    );
    expect(worstCertificateTone([failedAttempt()])).toBe("err");
  });

  /** With the request gone or unread, the Certificate's own sentence is the failure. */
  it("quotes Issuing's own sentence where no request is left to walk", () => {
    const [row] = certificateRows([failedAttempt()], [], [], [], t);
    expect(row.state).toEqual({ text: "renewal failing", tone: "err" });
    expect(row.failure).toBe(`${RETRIED}order is invalid`);
  });

  /**
   * A success removes Issuing; under cert-manager's server-side apply it is
   * left False with reason `Issued`. Fails if that reads as a failed attempt
   * and a healthy certificate turns red.
   */
  it("is not failing where Issuing=False says Issued", () => {
    const [row] = certificateRows(
      [
        certificate({
          ready: true,
          notAfter: inDays(60),
          attempt: {
            reason: "Issued",
            message: "The certificate has been successfully issued",
          },
        }),
      ],
      [],
      [],
      [],
      t
    );
    expect(row.state.tone).toBe("ok");
    expect(row.steps).toEqual([]);
    expect(row.failure).toBeNull();
  });
});

describe("a failed attempt, on the row and in the conditions block", () => {
  /**
   * The Certificates row and the generic conditions block read one Issuing
   * condition with two rules. Fails if they part on which is a failed
   * attempt: red in the block beside a healthy row, or the other way round.
   */
  it("is the same Issuing on both", () => {
    const cases: Array<[string, string | null]> = [
      ["True", "Renewing"],
      ["False", "Issued"],
      ["False", "Failed"],
      ["False", "Denied"],
      ["False", null],
      ["Unknown", null],
    ];
    for (const [status, reason] of cases) {
      const painted = conditionRole({
        type: "Issuing",
        status,
        reason,
        message: null,
        lastTransitionTime: null,
      });
      expect(attemptFailed({ status, reason }), `${status}/${reason}`).toBe(
        painted === "err"
      );
    }
  });
});

describe("a step that failed under a certificate still Ready", () => {
  const renewing = () =>
    certificate({
      uid: "cert-s",
      ready: true,
      issuing: true,
      notAfter: inDays(60),
      readyMessage: "Certificate is up to date and has not expired",
    });
  const pending = ownedBy("cert-s", {
    uid: "req-s",
    kind: "CertificateRequest",
    name: "web-cert-4",
    status: {
      conditions: [
        {
          type: "Ready",
          status: "False",
          reason: "Pending",
          message: "Waiting on certificate issuance from order",
        },
      ],
    },
  });
  const order = (state: string, reason?: string) =>
    ownedBy("req-s", {
      uid: "order-s",
      kind: "Order",
      name: "web-cert-4-1",
      status: { state, ...(reason && { reason }) },
    });

  /**
   * An approver's "no" is written as a `Denied` condition, before any Ready.
   * Fails if a denied request under a serving certificate reads as a
   * renewal still under way.
   */
  it("is failing once an approver denied the request", () => {
    const denied = ownedBy("cert-s", {
      uid: "req-d",
      kind: "CertificateRequest",
      name: "web-cert-4",
      status: {
        conditions: [
          {
            type: "Denied",
            status: "True",
            reason: "policy.cert-manager.io",
            message: "No policy approved this request",
          },
        ],
      },
    });
    const [row] = certificateRows([renewing()], [denied], [], [], t);
    expect(row.state).toEqual({ text: "renewal failing", tone: "err" });
    expect(row.steps[1].failed).toBe(true);
    expect(row.failure).toBe("No policy approved this request");
  });

  /** ACME's own error states, one level down each: `invalid`, `errored`, `expired`. */
  it("is failing once the Order or a Challenge is in an error state", () => {
    const [byOrder] = certificateRows(
      [renewing()],
      [pending],
      [order("invalid", "Failed to finalize Order: 403 urn:ietf:params:acme")],
      [],
      t
    );
    expect(byOrder.state).toEqual({ text: "renewal failing", tone: "err" });
    expect(byOrder.failure).toContain("Failed to finalize Order");

    const challenge = ownedBy("order-s", {
      uid: "chal-s",
      kind: "Challenge",
      name: "web-cert-4-1-0",
      spec: { type: "DNS-01", dnsName: "shop.example.com" },
      status: { state: "errored", reason: "DNS record not yet propagated" },
    });
    const [byChallenge] = certificateRows(
      [renewing()],
      [pending],
      [order("pending")],
      [challenge],
      t
    );
    expect(byChallenge.state).toEqual({ text: "renewal failing", tone: "err" });
    expect(byChallenge.failure).toBe("DNS record not yet propagated");

    // And the same walk with nothing in an error state is still a renewal.
    const [waiting] = certificateRows(
      [renewing()],
      [pending],
      [order("pending")],
      [{ ...challenge, status: { state: "pending" } }],
      t
    );
    expect(waiting.state).toEqual({ text: "renewing", tone: "warn" });
    expect(waiting.failure).toBeNull();
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
      [],
      t
    );
    const [row] = issuerRows([issuer("le", { namespace: "shop" })], [], certs);
    expect(row.serves).toBe(1);
  });

  /**
   * `Unknown` is cert-manager not having answered, which the tab counted as
   * an issuer that is not ready and the row drew in red. Fails if a Ready
   * that is not `False` reads as a refusal again.
   */
  it("does not call an issuer whose Ready is Unknown not ready", () => {
    const unknown = resource({
      name: "le",
      kind: "Issuer",
      spec: { selfSigned: {} },
      status: { conditions: [{ type: "Ready", status: "Unknown" }] },
    });
    expect(issuerRows([unknown], [], [])[0].ready).toBeNull();
    expect(issuerRows([issuer("bad", { ready: false })], [], [])[0].ready).toBe(
      false
    );
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

describe("acmeServerLabel", () => {
  /**
   * The name is read off the directory's host: a URL that only mentions
   * letsencrypt.org in its path or under another domain is somebody else's
   * ACME server and keeps its own address.
   */
  it("names Let's Encrypt only when the directory is on its host", () => {
    expect(
      acmeServerLabel("https://acme-v02.api.letsencrypt.org/directory")
    ).toBe("Let's Encrypt");
    expect(
      acmeServerLabel("https://acme-staging-v02.api.letsencrypt.org/directory")
    ).toBe("Let's Encrypt staging");
    expect(
      acmeServerLabel("https://acme.example.com/letsencrypt.org/directory")
    ).toBe("https://acme.example.com/letsencrypt.org/directory");
    expect(acmeServerLabel("https://letsencrypt.org.example.com/dir")).toBe(
      "https://letsencrypt.org.example.com/dir"
    );
  });
});
