/**
 * cert-manager's objects, read as one answer per certificate.
 *
 * `Certificate` → `CertificateRequest` → `Order` → `Challenge` is four
 * unrelated custom resources on four list pages, and the reader walks them by
 * hand every time a renewal stops. This walks them once, in the browser, off
 * the four cluster-wide lists the page already has — the same lists the
 * sidebar count is read from, so the walk costs nothing extra.
 *
 * The backend's `certificate.issuance` capability answers the same question
 * from the other end: it starts at a Secret an Ingress named and is what the
 * Ingress and Secret pages ask. It is deliberately not reused here — it lists
 * every Certificate in a namespace per call, and a page with forty rows would
 * make forty of those calls to draw one screen.
 *
 * Nothing on the walk is paraphrased. `state` is the word the object uses for
 * itself and `note` is the controller's own sentence, because a rewritten
 * error is a second guess at somebody else's failure and the string is what
 * the reader will paste into a search.
 */

import { managedExpiryOf, type Expiry } from "@/lib/certificates";
import type { CustomResourceInfo, IngressInfo } from "@/generated/types";

import { conditionOf, getValueByPath, type VendorCondition } from "../kit";
import type { Tone } from "../page-kit";
import { certificateUse, type CertificateUse } from "./serves";

export const CERTIFICATES_CRD = "certificates.cert-manager.io";
export const REQUESTS_CRD = "certificaterequests.cert-manager.io";
export const ORDERS_CRD = "orders.acme.cert-manager.io";
export const CHALLENGES_CRD = "challenges.acme.cert-manager.io";
export const ISSUERS_CRD = "issuers.cert-manager.io";
export const CLUSTER_ISSUERS_CRD = "clusterissuers.cert-manager.io";

/** One object on the way from "I want a certificate" to a certificate. */
export interface CertStep {
  kind: string;
  name: string;
  namespace: string | null;
  crd: string;
  /** The word the object uses for itself: `pending`, `valid`, `errored`. */
  state: string;
  /** The controller's own sentence, verbatim. */
  note: string | null;
  failed: boolean;
}

export interface IssuerRef {
  name: string;
  kind: string;
}

export interface CertRow {
  key: string;
  name: string;
  namespace: string;
  secretName: string | null;
  issuer: IssuerRef | null;
  dnsNames: string[];
  /** What the certificate itself says, once there is one. */
  expiry: Expiry | null;
  renewalTime: string | null;
  failedAttempts: number | null;
  ready: boolean;
  /** cert-manager is trying to issue or renew right now. */
  inFlight: boolean;
  /** No certificate has ever been written to the Secret. */
  neverIssued: boolean;
  /** The deepest message on the walk — the one that says what actually failed. */
  failure: string | null;
  steps: CertStep[];
  state: { text: string; tone: Tone };
  /**
   * The hostnames this certificate is actually serving, through whatever
   * mounts its Secret — see `./serves`.
   *
   * The half a `Certificate` never states about itself, and the half
   * somebody is asking about: "thirty days left" is not actionable until you
   * know which address stops working.
   */
  use: CertificateUse;
  /** Sort rank: lower is more urgent. */
  rank: number;
}

export interface IssuerRow {
  key: string;
  name: string;
  /** `null` for a ClusterIssuer, which is the difference that matters. */
  namespace: string | null;
  kind: "Issuer" | "ClusterIssuer";
  crd: string;
  /** ACME, CA, SelfSigned, Vault, Venafi — or `null` where the spec is new to us. */
  type: string | null;
  detail: string | null;
  /** `null` where the controller has not written a `Ready` condition yet. */
  ready: boolean | null;
  message: string | null;
  /** How many Certificates name it. Nobody's issuer is a real finding. */
  serves: number;
}

/**
 * A kind this page needed and did not get.
 *
 * "The API server does not serve this kind" and "this read failed" are
 * different facts and only one of them is an absence: a CA-only install has
 * no `Order` CRD and genuinely has no orders, while a kubeconfig without
 * cluster-scoped `list clusterissuers` has read nothing about a cluster that
 * may be signing everything it has. Both used to arrive here as an empty
 * list, which is how a page came to tell a reader their working ClusterIssuer
 * did not exist.
 */
export interface UnreadKind {
  /** The kind as cert-manager names it: `ClusterIssuer`, `Order`. */
  kind: string;
  crd: string;
  /** The API server's own sentence, verbatim. */
  reason: string;
}

export interface CertPicture {
  certificates: CertRow[];
  issuers: IssuerRow[];
  /** Whether the ACME kinds are served at all — a CA-only install has none,
   *  and a kind nobody could read is not counted as absent. */
  acme: boolean;
  /**
   * Kinds nothing on this page may speak for. Every list drawn from one of
   * them is short by an unknown amount, so a surface that states an absence
   * has to check this first.
   */
  unread: UnreadKind[];
}

function text(resource: CustomResourceInfo, path: string): string | null {
  const value = getValueByPath(resource, path);
  return typeof value === "string" && value !== "" ? value : null;
}

function strings(resource: CustomResourceInfo, path: string): string[] {
  const value = getValueByPath(resource, path);
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** The controller's word for where a condition stands, then its type. */
function stateOf(condition: VendorCondition | null, fallback: string): string {
  return condition?.reason || condition?.status || fallback;
}

const ownedBy = (resource: CustomResourceInfo, uid: string): boolean =>
  resource.ownerReferences.some((owner) => owner.uid === uid);

/**
 * The revision an ACME request is for, so the newest one is the one walked.
 *
 * A certificate that has failed four times has four CertificateRequests, and
 * three of them are history — showing the oldest would report a failure that
 * was fixed a week ago.
 */
function revisionOf(resource: CustomResourceInfo): number {
  const raw = resource.annotations["cert-manager.io/certificate-revision"];
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function newest(resources: CustomResourceInfo[]): CustomResourceInfo | null {
  if (resources.length === 0) return null;
  return resources.reduce((best, candidate) =>
    revisionOf(candidate) > revisionOf(best) ||
    (candidate.createdAt ?? "") > (best.createdAt ?? "")
      ? candidate
      : best
  );
}

/**
 * The walk, and only when there is one to draw.
 *
 * A certificate that is simply serving has nothing in flight. Drawing four
 * green steps under every healthy row is how the walk stops being read on the
 * one row where it is the answer.
 */
function walk(
  certificate: CustomResourceInfo,
  requests: CustomResourceInfo[],
  orders: CustomResourceInfo[],
  challenges: CustomResourceInfo[]
): { steps: CertStep[]; failure: string | null } {
  const issuing = conditionOf(certificate, "Issuing");
  const ready = conditionOf(certificate, "Ready");

  const steps: CertStep[] = [
    {
      kind: "Certificate",
      name: certificate.name,
      namespace: certificate.namespace,
      crd: CERTIFICATES_CRD,
      state: stateOf(issuing, "pending"),
      note: issuing?.message ?? null,
      failed: false,
    },
  ];
  let deepest = ready?.message ?? null;

  const request = newest(
    requests.filter((item) => ownedBy(item, certificate.uid))
  );
  if (!request) return { steps, failure: deepest };

  const requestReady = conditionOf(request, "Ready");
  const denied = conditionOf(request, "Denied");
  const requestFailed =
    denied?.status === "True" ||
    requestReady?.reason === "Failed" ||
    requestReady?.reason === "Denied";
  deepest = denied?.message ?? requestReady?.message ?? deepest;
  steps.push({
    kind: "CertificateRequest",
    name: request.name,
    namespace: request.namespace,
    crd: REQUESTS_CRD,
    state: stateOf(
      denied?.status === "True" ? denied : requestReady,
      "pending"
    ),
    note: denied?.message ?? requestReady?.message ?? null,
    failed: requestFailed,
  });
  if (requestFailed) return { steps, failure: deepest };

  const order = newest(orders.filter((item) => ownedBy(item, request.uid)));
  if (!order) return { steps, failure: deepest };

  const orderState = text(order, "status.state") ?? "pending";
  const orderReason = text(order, "status.reason");
  deepest = orderReason ?? deepest;
  const orderFailed = orderState === "errored" || orderState === "invalid";
  steps.push({
    kind: "Order",
    name: order.name,
    namespace: order.namespace,
    crd: ORDERS_CRD,
    state: orderState,
    note: orderReason,
    failed: orderFailed,
  });
  if (orderFailed) return { steps, failure: deepest };

  // Every unproven domain at once, not the first: a certificate for four
  // hosts routinely fails on one of them, and naming that one is the answer.
  for (const challenge of challenges.filter((item) =>
    ownedBy(item, order.uid)
  )) {
    const state = text(challenge, "status.state") ?? "pending";
    const reason = text(challenge, "status.reason");
    const failed = state === "invalid" || state === "expired";
    if (reason && (failed || state !== "valid")) deepest = reason;
    // Without a reason, which domain is being proved and how is the whole of
    // what the step says — and it is what tells `_acme-challenge` apart from
    // the HTTP path that never got served.
    const proving = [
      text(challenge, "spec.type"),
      text(challenge, "spec.dnsName"),
    ]
      .filter(Boolean)
      .join(" for ");
    steps.push({
      kind: "Challenge",
      name: challenge.name,
      namespace: challenge.namespace,
      crd: CHALLENGES_CRD,
      state,
      note: reason ?? (proving === "" ? null : proving),
      failed,
    });
  }

  return { steps, failure: deepest };
}

/**
 * What is true of one certificate right now, in one phrase and one colour.
 *
 * Ordered the way the reader would triage it: a Secret that does not exist
 * beats a renewal that is failing while the old certificate still serves,
 * which beats one that is merely running out.
 */
function stateOfCertificate(row: {
  neverIssued: boolean;
  ready: boolean;
  inFlight: boolean;
  expiry: Expiry | null;
  failure: string | null;
}): { text: string; tone: Tone; rank: number } {
  if (row.neverIssued) {
    return { text: "never issued", tone: "err", rank: 0 };
  }
  if (row.expiry?.expired) {
    return { text: row.expiry.text, tone: "err", rank: 1 };
  }
  // Still serving, and cert-manager cannot replace it. The old certificate
  // has until `notAfter` to be fixed, which is why this is not an outage and
  // is still the loudest thing on a healthy-looking row.
  if (!row.ready || (row.inFlight && row.failure)) {
    return { text: "renewal failing", tone: "err", rank: 2 };
  }
  if (row.expiry?.tone === "err") {
    return { text: row.expiry.text, tone: "err", rank: 3 };
  }
  if (row.expiry?.tone === "warn") {
    return { text: row.expiry.text, tone: "warn", rank: 4 };
  }
  if (row.inFlight) return { text: "renewing", tone: "warn", rank: 5 };
  return { text: row.expiry?.text ?? "issued", tone: "ok", rank: 6 };
}

export function certificateRows(
  certificates: CustomResourceInfo[],
  requests: CustomResourceInfo[],
  orders: CustomResourceInfo[],
  challenges: CustomResourceInfo[],
  /** What mounts the Secrets, for the hosts each certificate serves. */
  ingresses: IngressInfo[] = [],
  /** False where a routing CRD this file cannot read may also mount them. */
  unusedIsCertain = false
): CertRow[] {
  return certificates
    .map((certificate): CertRow => {
      const ready = conditionOf(certificate, "Ready");
      const issuing = conditionOf(certificate, "Issuing");
      const notAfter = text(certificate, "status.notAfter");
      const notBefore = text(certificate, "status.notBefore");
      const renewalTime = text(certificate, "status.renewalTime");
      const isReady = ready?.status === "True";
      const inFlight = issuing?.status === "True" || !isReady;

      const { steps, failure } = inFlight
        ? walk(certificate, requests, orders, challenges)
        : { steps: [], failure: null };

      const row = {
        neverIssued: !isReady && notAfter === null,
        ready: isReady,
        inFlight,
        expiry:
          notAfter !== null
            ? managedExpiryOf(
                { notAfter, notBefore: notBefore ?? "" },
                renewalTime
              )
            : null,
        failure,
      };
      const state = stateOfCertificate(row);
      const issuerName = text(certificate, "spec.issuerRef.name");

      const namespace = certificate.namespace ?? "";
      const secretName = text(certificate, "spec.secretName");
      const dnsNames = strings(certificate, "spec.dnsNames");

      return {
        key: `${namespace}/${certificate.name}`,
        name: certificate.name,
        namespace,
        secretName,
        use: certificateUse({ secretName, namespace, dnsNames }, ingresses, {
          unusedIsCertain,
        }),
        issuer: issuerName
          ? {
              name: issuerName,
              kind: text(certificate, "spec.issuerRef.kind") ?? "Issuer",
            }
          : null,
        dnsNames,
        renewalTime,
        failedAttempts:
          typeof getValueByPath(
            certificate,
            "status.failedIssuanceAttempts"
          ) === "number"
            ? (getValueByPath(
                certificate,
                "status.failedIssuanceAttempts"
              ) as number)
            : null,
        steps,
        ...row,
        state: { text: state.text, tone: state.tone },
        rank: state.rank,
      };
    })
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (a.expiry?.days ?? Infinity) - (b.expiry?.days ?? Infinity) ||
        a.name.localeCompare(b.name)
    );
}

/** ACME, CA, SelfSigned, Vault, Venafi — and what each one points at. */
function issuerKindOf(
  issuer: CustomResourceInfo
): { type: string; detail: string | null } | null {
  const spec = getValueByPath(issuer, "spec");
  if (spec === null || typeof spec !== "object") return null;
  const fields = spec as Record<string, unknown>;

  if (fields.acme) {
    const server = text(issuer, "spec.acme.server");
    if (server?.includes("letsencrypt.org")) {
      return {
        type: "ACME",
        detail: server.includes("staging")
          ? "Let's Encrypt staging"
          : "Let's Encrypt",
      };
    }
    return { type: "ACME", detail: server };
  }
  if (fields.ca) {
    return { type: "CA", detail: text(issuer, "spec.ca.secretName") };
  }
  if (fields.selfSigned) return { type: "SelfSigned", detail: null };
  if (fields.vault) {
    return { type: "Vault", detail: text(issuer, "spec.vault.server") };
  }
  if (fields.venafi) return { type: "Venafi", detail: null };
  return null;
}

/**
 * Every issuer this cluster has, with how many certificates name it.
 *
 * A ClusterIssuer is matched by name alone and an Issuer by name *and*
 * namespace, which is the whole of the difference between them and the
 * reason a certificate naming `Issuer/letsencrypt` from the wrong namespace
 * never issues.
 */
export function issuerRows(
  issuers: CustomResourceInfo[],
  clusterIssuers: CustomResourceInfo[],
  certificates: CertRow[]
): IssuerRow[] {
  const build = (
    issuer: CustomResourceInfo,
    kind: "Issuer" | "ClusterIssuer"
  ): IssuerRow => {
    const ready = conditionOf(issuer, "Ready");
    const shape = issuerKindOf(issuer);
    return {
      key: `${kind}/${issuer.namespace ?? ""}/${issuer.name}`,
      name: issuer.name,
      namespace: kind === "ClusterIssuer" ? null : (issuer.namespace ?? ""),
      kind,
      crd: kind === "ClusterIssuer" ? CLUSTER_ISSUERS_CRD : ISSUERS_CRD,
      type: shape?.type ?? null,
      detail: shape?.detail ?? null,
      ready: ready ? ready.status === "True" : null,
      message: ready?.status === "True" ? null : (ready?.message ?? null),
      serves: certificates.filter(
        (certificate) =>
          certificate.issuer?.name === issuer.name &&
          certificate.issuer.kind === kind &&
          (kind === "ClusterIssuer" ||
            certificate.namespace === (issuer.namespace ?? ""))
      ).length,
    };
  };

  return [
    ...clusterIssuers.map((issuer) => build(issuer, "ClusterIssuer")),
    ...issuers.map((issuer) => build(issuer, "Issuer")),
  ].sort(
    (a, b) =>
      Number(a.ready !== false) - Number(b.ready !== false) ||
      a.name.localeCompare(b.name)
  );
}

/** How many certificates are a reason to open the page. */
export function troubled(rows: CertRow[]): CertRow[] {
  return rows.filter((row) => row.state.tone !== "ok");
}

/**
 * The one colour a whole page of certificates is worth in the rail.
 *
 * Judged from the certificates alone — the sidebar's query — so a failure
 * whose sentence lives three objects down the walk still registers here:
 * `Ready=False` is on the Certificate itself, whatever the Challenge says.
 */
export function worstCertificateTone(
  certificates: CustomResourceInfo[]
): "warn" | "err" | null {
  const rows = certificateRows(certificates, [], [], []);
  if (rows.some((row) => row.state.tone === "err")) return "err";
  if (rows.some((row) => row.state.tone === "warn")) return "warn";
  return null;
}
