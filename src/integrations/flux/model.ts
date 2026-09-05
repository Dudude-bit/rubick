/**
 * What Flux is doing, in the shape Flux actually has.
 *
 * Flux splits source from applier — a `GitRepository` fetches, a
 * `Kustomization` applies, several appliers share one source — so they are
 * separate tabs with the link drawn rather than collapsed. Flattening hides
 * the most common Flux failure: a source that stopped fetching while every
 * applier below it keeps reporting the last revision it applied. Only the
 * source says "failed", every Kustomization reads `Ready`, and the cluster
 * quietly runs week-old manifests.
 *
 * `dependsOn` is a real ordering, and Flux writes `dependency
 * 'flux-system/platform' is not ready` on everything held up — true and
 * useless alone, so the reconciler that is actually broken is named with what
 * it says. Suspension is first class: a suspended `Kustomization` keeps its
 * last successful `Ready`, so it reads healthy in every list while
 * reconciling nothing.
 *
 * A `HelmRelease` is a reconciler, not a third thing — same interval,
 * suspension, `dependsOn`, failures — so it is a row beside the
 * Kustomizations, with a `HelmRepository` or `OCIRepository` for a source and
 * a chart at a version rather than a path at a commit for a unit.
 *
 * Everything comes from the CRDs' own `status.conditions`: no credential and,
 * unlike Argo, no vendor UI to hand the rest to.
 */

import type { VendorVerdict } from "../kit";
import type { T } from "@/i18n/useT";
import type { CustomResourceInfo } from "@/generated/types";
import { conditionOf, conditionsOf, getValueByPath } from "../kit";
import { shortRevision } from "../gitops";

/**
 * A Flux revision: `master@sha1:eec06d1…`, and the older `master/eec06d1`.
 *
 * Split rather than printed whole: the two halves answer different questions
 * — the ref is what the object asked for, the commit is what it got — and the
 * whole 60-character string in a table column is one nobody reads.
 */
export interface FluxRevision {
  raw: string;
  ref: string | null;
  commit: string | null;
}

export function readRevision(raw: string | null): FluxRevision | null {
  if (!raw) return null;
  const at = raw.lastIndexOf("@");
  if (at !== -1) {
    const commit = raw.slice(at + 1);
    const colon = commit.indexOf(":");
    return {
      raw,
      ref: raw.slice(0, at),
      commit: colon === -1 ? commit : commit.slice(colon + 1),
    };
  }
  const slash = raw.lastIndexOf("/");
  if (slash !== -1) {
    return { raw, ref: raw.slice(0, slash), commit: raw.slice(slash + 1) };
  }
  return { raw, ref: null, commit: raw };
}

/** How a revision is written on a row. */
export function revisionText(revision: FluxRevision | null, t: T): string {
  if (!revision) return t("empty", "noRevision");
  if (!revision.commit) return revision.raw;
  return revision.ref
    ? `${revision.ref}@${shortRevision(revision.commit)}`
    : shortRevision(revision.commit);
}

export interface SourceRef {
  kind: string;
  name: string;
  namespace: string;
}

export type FluxFinding =
  /** Not reconciling and not failing, which is the dangerous combination. */
  | {
      kind: "suspended";
      severity: "warn";
      wasReady: boolean;
      applied: FluxRevision | null;
      at: string | null;
    }
  /** The source stopped fetching, and everything under it is frozen. */
  | {
      kind: "frozen";
      severity: "err";
      source: FluxSource;
      message: string | null;
      applied: FluxRevision | null;
    }
  /** The source is not delivering, and this has applied nothing at all. */
  | {
      kind: "noSource";
      severity: "err";
      source: FluxSource | null;
      /** Whether the source ever produced an artifact, which changes the sentence. */
      everFetched: boolean;
      message: string | null;
    }
  /** It says why itself. */
  | {
      kind: "notReady";
      severity: "err";
      reason: string | null;
      message: string | null;
    }
  /** Retries are exhausted; it will not try again without a change. */
  | { kind: "stalled"; severity: "err"; message: string | null }
  /** What this one is holding up. */
  | { kind: "blocking"; severity: "err"; blocked: string[] }
  /** What is holding this one up, and what is actually wrong with it. */
  | {
      kind: "waiting";
      severity: "warn";
      on: string;
      because: string | null;
    }
  /** A source nobody applies. */
  | { kind: "unused"; severity: "warn" }
  /** A source that is failing, and who is frozen because of it. */
  | {
      kind: "fetchFailing";
      severity: "err";
      message: string | null;
      frozen: string[];
      everFetched: boolean;
    };

export interface FluxSource {
  kind: string;
  name: string;
  namespace: string;
  url: string | null;
  /** The branch, tag, semver range or chart the source tracks. */
  ref: string | null;
  interval: string | null;
  suspended: boolean;
  /** `null` where the controller has written no `Ready` condition yet. */
  ready: boolean | null;
  /** The controller's own sentence, never rewritten. */
  message: string | null;
  artifact: { revision: FluxRevision | null; at: string | null } | null;
  /** Reconcilers that name this source. Filled in by {@link fluxPicture}. */
  usedBy: string[];
  findings: FluxFinding[];
  worst: "err" | "warn" | null;
}

export interface FluxReconciler {
  kind: string;
  name: string;
  namespace: string;
  key: string;
  sourceRef: SourceRef | null;
  /** `./clusters/prod` for a Kustomization, `podinfo 6.5.4` for a release. */
  unit: string;
  interval: string | null;
  suspended: boolean;
  ready: boolean | null;
  reason: string | null;
  message: string | null;
  /**
   * Why it has given up retrying, where it has. A HelmRelease whose upgrade
   * failed its retry budget sits `Stalled` and will not try again until the
   * spec changes — which is a different sentence from "it is failing".
   */
  stalled: string | null;
  applied: FluxRevision | null;
  lastReconciledAt: string | null;
  dependsOn: SourceRef[];
  /** Objects this reconciler owns, where the kind reports an inventory. */
  objects: number | null;
  source: FluxSource | null;
  findings: FluxFinding[];
  worst: "err" | "warn" | null;
}

const KUSTOMIZATION = "Kustomization";
const HELM_RELEASE = "HelmRelease";

/** Everything the page draws, with the two halves joined up. */
export interface FluxPicture {
  reconcilers: FluxReconciler[];
  sources: FluxSource[];
}

export function fluxPicture(
  kustomizations: CustomResourceInfo[],
  helmReleases: CustomResourceInfo[],
  sourceObjects: Array<{ kind: string; objects: CustomResourceInfo[] }>
): FluxPicture {
  const sources = sourceObjects.flatMap(({ kind, objects }) =>
    objects.map((object) => readSource(kind, object))
  );
  const byKey = new Map(
    sources.map((source) => [
      `${source.kind}/${source.namespace}/${source.name}`,
      source,
    ])
  );

  const reconcilers = [
    ...kustomizations.map(readKustomization),
    ...helmReleases.map(readHelmRelease),
  ];

  for (const reconciler of reconcilers) {
    if (!reconciler.sourceRef) continue;
    const source =
      byKey.get(
        `${reconciler.sourceRef.kind}/${reconciler.sourceRef.namespace}/${reconciler.sourceRef.name}`
      ) ?? null;
    reconciler.source = source;
    if (source) source.usedBy.push(reconciler.key);
  }

  for (const reconciler of reconcilers) {
    reconciler.findings = findingsFor(reconciler, reconcilers);
    reconciler.worst = worstOf(reconciler.findings);
  }
  for (const source of sources) {
    source.findings = sourceFindings(source, reconcilers);
    source.worst = worstOf(source.findings);
  }

  return {
    reconcilers: byTrouble(reconcilers),
    sources: sourcesByTrouble(sources),
  };
}

function readSource(kind: string, object: CustomResourceInfo): FluxSource {
  const ready = conditionOf(object, "Ready");
  const fetchFailed = conditionOf(object, "FetchFailed");
  const revision = readRevision(
    (getValueByPath(object, "status.artifact.revision") as string) ?? null
  );
  return {
    kind,
    name: object.name,
    namespace: object.namespace ?? "",
    url: (getValueByPath(object, "spec.url") as string) ?? null,
    ref: refOf(object),
    interval: (getValueByPath(object, "spec.interval") as string) ?? null,
    suspended: getValueByPath(object, "spec.suspend") === true,
    ready: ready ? ready.status === "True" : null,
    // FetchFailed is the specific sentence where there is one; Ready's copy of
    // it is the same string, and where they differ the specific one is why.
    message: fetchFailed?.message ?? ready?.message ?? null,
    artifact: revision
      ? {
          revision,
          at:
            (getValueByPath(
              object,
              "status.artifact.lastUpdateTime"
            ) as string) ?? null,
        }
      : null,
    usedBy: [],
    findings: [],
    worst: null,
  };
}

/** What a source tracks, spelled four different ways by four kinds. */
function refOf(object: CustomResourceInfo): string | null {
  const ref = getValueByPath(object, "spec.ref") as
    | {
        branch?: string;
        tag?: string;
        semver?: string;
        commit?: string;
        name?: string;
      }
    | undefined;
  if (ref) {
    return (
      ref.branch ?? ref.tag ?? ref.semver ?? ref.commit ?? ref.name ?? null
    );
  }
  return (getValueByPath(object, "spec.chart") as string) ?? null;
}

function readKustomization(object: CustomResourceInfo): FluxReconciler {
  const inventory = getValueByPath(object, "status.inventory.entries");
  return base(object, KUSTOMIZATION, {
    unit: (getValueByPath(object, "spec.path") as string) ?? "./",
    sourceRef: sourceRefOf(object, "spec.sourceRef", "GitRepository"),
    applied: readRevision(
      (getValueByPath(object, "status.lastAppliedRevision") as string) ?? null
    ),
    objects: Array.isArray(inventory) ? inventory.length : null,
  });
}

function readHelmRelease(object: CustomResourceInfo): FluxReconciler {
  const chart =
    (getValueByPath(object, "spec.chart.spec.chart") as string) ??
    (getValueByPath(object, "spec.chartRef.name") as string) ??
    object.name;
  // What is installed, then what was asked for. A release pinned to `>=6.0.0`
  // has a range in its spec and a version in its history, and the version is
  // the answer to "what is running".
  const version =
    (getValueByPath(object, "status.history[0].chartVersion") as string) ??
    (getValueByPath(object, "status.lastAttemptedRevision") as string) ??
    (getValueByPath(object, "spec.chart.spec.version") as string) ??
    null;
  return base(object, HELM_RELEASE, {
    unit: version ? `${chart} ${version}` : chart,
    sourceRef: sourceRefOf(
      object,
      "spec.chart.spec.sourceRef",
      "HelmRepository"
    ),
    applied: readRevision(version),
    // A HelmRelease keeps no inventory: what it owns is Helm's, in the
    // release's own storage, and claiming a number here would be a guess.
    objects: null,
  });
}

function base(
  object: CustomResourceInfo,
  kind: string,
  rest: Pick<FluxReconciler, "unit" | "sourceRef" | "applied" | "objects">
): FluxReconciler {
  const ready = conditionOf(object, "Ready");
  const stalled = conditionsOf(object).find(
    (condition) => condition.type === "Stalled" && condition.status === "True"
  );
  const namespace = object.namespace ?? "";
  const dependsOn = (getValueByPath(object, "spec.dependsOn") ?? []) as Array<{
    name?: string;
    namespace?: string;
  }>;
  return {
    kind,
    name: object.name,
    namespace,
    key: `${namespace}/${object.name}`,
    interval: (getValueByPath(object, "spec.interval") as string) ?? null,
    suspended: getValueByPath(object, "spec.suspend") === true,
    ready: ready ? ready.status === "True" : null,
    reason: ready?.reason ?? null,
    message: ready?.message ?? null,
    stalled: stalled?.message ?? null,
    lastReconciledAt: ready?.lastTransitionTime ?? null,
    dependsOn: dependsOn
      .filter((entry): entry is { name: string; namespace?: string } =>
        Boolean(entry?.name)
      )
      .map((entry) => ({
        kind,
        name: entry.name,
        namespace: entry.namespace ?? namespace,
      })),
    source: null,
    findings: [],
    worst: null,
    ...rest,
  };
}

function sourceRefOf(
  object: CustomResourceInfo,
  path: string,
  fallbackKind: string
): SourceRef | null {
  const ref = getValueByPath(object, path) as
    { kind?: string; name?: string; namespace?: string } | undefined;
  if (!ref?.name) return null;
  return {
    kind: ref.kind ?? fallbackKind,
    name: ref.name,
    namespace: ref.namespace ?? object.namespace ?? "",
  };
}

/**
 * What is wrong with one reconciler, and — the part no list gives you — what
 * that means for the rest.
 */
function findingsFor(
  reconciler: FluxReconciler,
  all: FluxReconciler[]
): FluxFinding[] {
  const findings: FluxFinding[] = [];
  const source = reconciler.source;

  // Suspension first and always. Everything below is about a controller that
  // is acting; this one is not, and the state it froze in is irrelevant to
  // whether the cluster matches git.
  if (reconciler.suspended) {
    findings.push({
      kind: "suspended",
      severity: "warn",
      wasReady: reconciler.ready === true,
      applied: reconciler.applied,
      at: reconciler.lastReconciledAt,
    });
  }

  // What it is waiting for, worked out before what is wrong with its source:
  // a reconciler held behind an unready dependency has not reached the fetch
  // at all, so reporting its source as the problem would name a step Flux
  // never took.
  const waitingOn =
    !reconciler.suspended && reconciler.ready === false
      ? reconciler.dependsOn
          .map((dependency) =>
            all.find(
              (candidate) =>
                candidate.name === dependency.name &&
                candidate.namespace === dependency.namespace
            )
          )
          .find(
            (candidate) => candidate !== undefined && candidate.ready !== true
          )
      : undefined;

  if (waitingOn) {
    findings.push({
      kind: "waiting",
      severity: "warn",
      on: waitingOn.name,
      because: waitingOn.message ?? null,
    });
  }

  // A suspended reconciler is not fetching and not applying, so what its
  // source is doing is not why the cluster does not match git — the
  // suspension is, and stacking a second red finding on it buries the one
  // sentence that matters.
  const reachedItsSource =
    !reconciler.suspended && (!waitingOn || reconciler.applied !== null);
  if (reachedItsSource && source && source.ready === false) {
    if (reconciler.applied) {
      findings.push({
        kind: "frozen",
        severity: "err",
        source,
        message: source.message,
        applied: reconciler.applied,
      });
    } else {
      findings.push({
        kind: "noSource",
        severity: "err",
        source,
        everFetched: source.artifact !== null,
        message: source.message,
      });
    }
  } else if (reachedItsSource && reconciler.sourceRef && !source) {
    findings.push({
      kind: "noSource",
      severity: "err",
      source: null,
      everFetched: false,
      message: null,
    });
  }

  if (!reconciler.suspended && reconciler.ready === false && !waitingOn) {
    findings.push({
      kind: "notReady",
      severity: "err",
      reason: reconciler.reason,
      message: reconciler.message,
    });
  }

  const blocked = all
    .filter((candidate) =>
      candidate.dependsOn.some(
        (dependency) =>
          dependency.name === reconciler.name &&
          dependency.namespace === reconciler.namespace
      )
    )
    .map((candidate) => candidate.name);
  // Only worth saying when this one is actually stuck: everything declaring a
  // healthy dependency is proceeding normally, and listing them would be
  // inventory dressed as a problem.
  if (
    blocked.length > 0 &&
    (reconciler.ready !== true || reconciler.suspended)
  ) {
    findings.push({ kind: "blocking", severity: "err", blocked });
  }

  if (reconciler.stalled) {
    findings.push({
      kind: "stalled",
      severity: "err",
      message: reconciler.stalled,
    });
  }

  return findings;
}

function sourceFindings(
  source: FluxSource,
  reconcilers: FluxReconciler[]
): FluxFinding[] {
  const findings: FluxFinding[] = [];
  if (source.ready === false) {
    // Suspended appliers are not frozen by this — they are not applying at
    // all, and naming them here would blame the source for a state somebody
    // chose.
    const frozen = reconcilers
      .filter(
        (reconciler) => reconciler.source === source && !reconciler.suspended
      )
      .map((reconciler) => reconciler.name);
    findings.push({
      kind: "fetchFailing",
      severity: "err",
      message: source.message,
      frozen,
      everFetched: source.artifact !== null,
    });
  }
  if (source.usedBy.length === 0 && source.ready !== false) {
    findings.push({ kind: "unused", severity: "warn" });
  }
  return findings;
}

function worstOf(findings: FluxFinding[]): "err" | "warn" | null {
  if (findings.some((finding) => finding.severity === "err")) return "err";
  if (findings.length > 0) return "warn";
  return null;
}

/**
 * The word at the right of a reconciler row.
 *
 * **A suspended reconciler is never "ready".** It keeps the `Ready=True` it
 * earned on its last run, so every list that reads that condition — Flux's own
 * CLI included — calls it healthy while it reconciles nothing. This is the one
 * place that refuses to.
 */
export function reconcilerState(
  reconciler: FluxReconciler,
  t: T
): VendorVerdict {
  if (reconciler.suspended) {
    return {
      text: t("action", "suspendedLower"),
      tone: reconciler.worst ?? "warn",
    };
  }
  if (reconciler.ready === false) {
    // A reconciler queued behind a broken dependency is not itself broken,
    // and colouring it the same red as the thing that *is* spreads one outage
    // across four rows.
    return {
      text: reconciler.findings.some((finding) => finding.kind === "waiting")
        ? t("empty", "fluxWaitingDependency")
        : t("empty", "notReadyLower"),
      tone: reconciler.worst ?? "err",
    };
  }
  if (reconciler.ready === null) {
    return { text: t("empty", "fluxNotReconciledYet"), tone: "warn" };
  }
  if (reconciler.findings.some((finding) => finding.kind === "frozen")) {
    return { text: t("empty", "fluxFrozenSource"), tone: "err" };
  }
  return { text: t("empty", "readyLower"), tone: reconciler.worst ?? "ok" };
}

export function sourceState(source: FluxSource, t: T): VendorVerdict {
  if (source.suspended)
    return { text: t("action", "suspendedLower"), tone: "warn" };
  if (source.ready === false) {
    return {
      text: source.artifact
        ? t("empty", "fluxFetchStale")
        : t("empty", "fluxNeverFetched"),
      tone: "err",
    };
  }
  if (source.ready === null)
    return { text: t("empty", "fluxNotFetchedYet"), tone: "warn" };
  if (source.usedBy.length === 0)
    return { text: t("empty", "fluxFetchedUnused"), tone: "warn" };
  return { text: t("empty", "fluxFetched"), tone: "ok" };
}

function rank(worst: "err" | "warn" | null): number {
  return worst === "err" ? 0 : worst === "warn" ? 1 : 2;
}

/**
 * Trouble first, and the *cause* of the trouble before its consequences: a
 * reconciler holding others up is the one to fix, and burying it under the
 * three rows it is blocking is the alphabet deciding where the answer goes.
 */
export function byTrouble(reconcilers: FluxReconciler[]): FluxReconciler[] {
  const order = (reconciler: FluxReconciler) =>
    rank(reconciler.worst) * 2 +
    (reconciler.findings.some((finding) => finding.kind === "blocking")
      ? 0
      : 1);
  return [...reconcilers].sort(
    (left, right) =>
      order(left) - order(right) || left.name.localeCompare(right.name)
  );
}

function sourcesByTrouble(sources: FluxSource[]): FluxSource[] {
  return [...sources].sort(
    (left, right) =>
      rank(left.worst) - rank(right.worst) ||
      left.name.localeCompare(right.name)
  );
}
