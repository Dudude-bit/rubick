/**
 * What Argo CD says about itself, read from the `Application` CRD alone.
 *
 * Delivery is asked about as *is this in sync, and if not, what differs and
 * since when*, so this is a list of Applications ordered by trouble, never by
 * name.
 *
 * `OutOfSync` is one word for two opposite problems, and a status column
 * cannot tell them apart:
 *
 * - **Sync failing with auto-sync on.** A manifest the API server refuses,
 *   retried forever. Argo is trying and will never converge; the fix is a
 *   commit.
 * - **Out of sync with auto-sync off.** Nothing is trying. Somebody changed
 *   the cluster by hand, or changed git and nobody pressed sync. The fix is a
 *   decision, and until it is made the cluster and git disagree quietly.
 *
 * Both are red in every list Argo or this app has ever drawn, and one is a
 * machine failing while the other is a person forgetting. Naming which is
 * which is the whole reason to read Argo here.
 *
 * Everything comes from the CRD's own status: detected, no credential, tier
 * 2. The line-by-line diff lives only in Argo's API and needs a token, which
 * is tier 3. So the page says which resources differ and why in Argo's own
 * words — `status.operationState.syncResult` carries the API server's refusal
 * verbatim — and hands the diff itself to Argo.
 */

import type { VendorVerdict } from "../kit";
import type { T } from "@/i18n/useT";
import type { CustomResourceInfo } from "@/generated/types";
import { getValueByPath } from "../kit";

/** Where an Application's manifests come from. */
export interface ArgoSource {
  repoUrl: string;
  /** A directory in the repository, for a git source. */
  path: string | null;
  /** A chart name, for a Helm source — which has no path. */
  chart: string | null;
  /** What the Application asks for: a branch, a tag, a range, a commit. */
  targetRevision: string | null;
}

/** One object an Application owns, as Argo reports it. */
export interface ArgoResource {
  group: string | null;
  kind: string;
  namespace: string | null;
  name: string;
  /** `Synced`, `OutOfSync`, or absent while Argo has not compared yet. */
  sync: string | null;
  health: string | null;
  /**
   * Argo's own sentence about this object, in this order of preference: why
   * the last sync could not apply it, then why it is unhealthy. Never
   * rewritten — it is usually the API server's own refusal, and it is what
   * the reader will paste into a search.
   */
  message: string | null;
  /** `SyncFailed` and the rest of Argo's per-object sync outcomes. */
  outcome: string | null;
}

export interface ArgoApp {
  name: string;
  namespace: string;
  project: string;
  destination: {
    server: string | null;
    name: string | null;
    namespace: string | null;
  };
  sources: ArgoSource[];
  autoSync: boolean;
  selfHeal: boolean;
  /** `Synced`, `OutOfSync`, `Unknown`. */
  sync: string;
  /** The commit Argo last compared against, which is not the branch asked for. */
  revision: string | null;
  health: string;
  healthMessage: string | null;
  /** When the last sync operation ended, which is the only age Argo states. */
  lastSyncAt: string | null;
  operationPhase: string | null;
  operationMessage: string | null;
  retries: number;
  resources: ArgoResource[];
  /**
   * The ApplicationSet that generated it, where one did. A generated
   * Application is a template's output: editing it is undone the next time
   * the generator runs, and the file to change is the ApplicationSet.
   */
  generatedBy: { kind: string; name: string } | null;
  conditions: ArgoCondition[];
  findings: ArgoFinding[];
  /** The worst finding's severity, and what orders the list. */
  worst: "err" | "warn" | null;
}

/**
 * Argo's conditions are not Kubernetes conditions.
 *
 * They carry a type and a message and **no status** — the presence of the
 * entry is the assertion. Reading them through the shared `VendorCondition`
 * helper would quietly treat every one of them as `status: undefined`, so
 * they get their own shape. This is the first place the two vendors were
 * tempting to unify and should not be.
 */
export interface ArgoCondition {
  type: string;
  message?: string;
  lastTransitionTime?: string;
}

export type ArgoFinding =
  /** Auto-sync is on, Argo is retrying, and it fails every time. */
  | {
      kind: "syncFailing";
      severity: "err";
      message: string | null;
      since: string | null;
      retries: number;
    }
  /** The last sync somebody asked for failed, and nothing is retrying it. */
  | {
      kind: "syncFailedOnce";
      severity: "err";
      message: string | null;
      since: string | null;
    }
  /** Out of sync with nothing on its way to fix it. */
  | { kind: "drifted"; severity: "warn"; since: string | null }
  /** Running and not working, which sync status says nothing about. */
  | {
      kind: "degraded";
      severity: "err";
      message: string | null;
      resources: ArgoResource[];
    }
  /** Argo itself is complaining — a bad project, an unreachable repo. */
  | { kind: "condition"; severity: "err" | "warn"; condition: ArgoCondition };

interface ApplicationSpec {
  project?: string;
  source?: RawSource;
  sources?: RawSource[];
  destination?: { server?: string; name?: string; namespace?: string };
  syncPolicy?: { automated?: { prune?: boolean; selfHeal?: boolean } | null };
}

interface RawSource {
  repoURL?: string;
  path?: string;
  chart?: string;
  targetRevision?: string;
}

const CONDITION_ERRORS = ["Error", "SyncError", "ComparisonError", "Unknown"];

export function readApplication(object: CustomResourceInfo): ArgoApp {
  const spec = (object.spec ?? {}) as ApplicationSpec;
  const automated = spec.syncPolicy?.automated;
  const rawSources = spec.sources ?? (spec.source ? [spec.source] : []);

  const operationPhase =
    (getValueByPath(object, "status.operationState.phase") as string) ?? null;
  const operationMessage =
    (getValueByPath(object, "status.operationState.message") as string) ?? null;
  const syncResults = (getValueByPath(
    object,
    "status.operationState.syncResult.resources"
  ) ?? []) as Array<{
    group?: string;
    kind?: string;
    namespace?: string;
    name?: string;
    status?: string;
    message?: string;
  }>;

  const app: ArgoApp = {
    name: object.name,
    namespace: object.namespace ?? "",
    project: spec.project ?? "default",
    destination: {
      server: spec.destination?.server ?? null,
      name: spec.destination?.name ?? null,
      namespace: spec.destination?.namespace ?? null,
    },
    sources: rawSources
      .filter((source): source is RawSource & { repoURL: string } =>
        Boolean(source.repoURL)
      )
      .map((source) => ({
        repoUrl: source.repoURL,
        path: source.path ?? null,
        chart: source.chart ?? null,
        targetRevision: source.targetRevision ?? null,
      })),
    autoSync: Boolean(automated),
    selfHeal: Boolean(automated?.selfHeal),
    sync: (getValueByPath(object, "status.sync.status") as string) ?? "Unknown",
    revision:
      (getValueByPath(object, "status.sync.revision") as string) ?? null,
    health:
      (getValueByPath(object, "status.health.status") as string) ?? "Unknown",
    healthMessage:
      (getValueByPath(object, "status.health.message") as string) ?? null,
    lastSyncAt:
      (getValueByPath(object, "status.operationState.finishedAt") as string) ??
      null,
    operationPhase,
    operationMessage,
    retries:
      (getValueByPath(object, "status.operationState.retryCount") as number) ??
      0,
    resources: readResources(object, syncResults),
    generatedBy: generatorOf(object),
    conditions: (
      (getValueByPath(object, "status.conditions") ?? []) as ArgoCondition[]
    ).filter((condition) => condition?.type),
    findings: [],
    worst: null,
  };

  app.findings = findingsFor(app, syncResults.length > 0);
  app.worst = worstOf(app.findings);
  return app;
}

function readResources(
  object: CustomResourceInfo,
  syncResults: Array<{
    group?: string;
    kind?: string;
    namespace?: string;
    name?: string;
    status?: string;
    message?: string;
  }>
): ArgoResource[] {
  const reported = (getValueByPath(object, "status.resources") ?? []) as Array<{
    group?: string;
    kind?: string;
    namespace?: string;
    name?: string;
    status?: string;
    health?: { status?: string; message?: string };
  }>;

  return reported.map((resource) => {
    const result = syncResults.find(
      (candidate) =>
        candidate.kind === resource.kind && candidate.name === resource.name
    );
    return {
      group: resource.group ?? null,
      kind: resource.kind ?? "",
      namespace: resource.namespace ?? null,
      name: resource.name ?? "",
      sync: resource.status ?? null,
      health: resource.health?.status ?? null,
      // The sync failure first: an object that could not be applied at all is
      // a more specific answer than the health of whatever is still running
      // from the revision before it.
      message:
        (result?.status && result.status !== "Synced"
          ? result.message
          : null) ??
        resource.health?.message ??
        null,
      outcome: result?.status ?? null,
    };
  });
}

/**
 * Whether an ApplicationSet made this Application.
 *
 * Read from `ownerReferences` rather than from a label: the generator sets
 * itself as the owner so that deleting it deletes what it made, and that is
 * the fact, not a convention anyone can copy onto a hand-written object.
 */
function generatorOf(
  object: CustomResourceInfo
): { kind: string; name: string } | null {
  const owner = object.ownerReferences.find(
    (reference) => reference.kind === "ApplicationSet"
  );
  return owner ? { kind: owner.kind, name: owner.name } : null;
}

/**
 * Whether the last sync failed, in Argo's words rather than by reading its
 * message.
 *
 * `phase` alone is not enough: a retrying automated sync sits at `Running`
 * with every object already reported `SyncFailed`, and calling that "in
 * progress" would draw a spinner over a manifest the API server has refused
 * five times.
 */
function syncFailed(app: ArgoApp, hadResults: boolean): boolean {
  if (app.operationPhase === "Failed" || app.operationPhase === "Error") {
    return true;
  }
  return (
    hadResults &&
    app.resources.some((resource) => resource.outcome === "SyncFailed")
  );
}

function findingsFor(app: ArgoApp, hadResults: boolean): ArgoFinding[] {
  const findings: ArgoFinding[] = [];
  const failed = syncFailed(app, hadResults);
  // Argo's own words, or nothing: our sentence in this slot would read as
  // the controller's, which it is not.
  const message =
    app.operationMessage ??
    app.resources.find((resource) => resource.message)?.message ??
    null;

  if (failed && app.autoSync) {
    findings.push({
      kind: "syncFailing",
      severity: "err",
      message,
      since: app.lastSyncAt,
      retries: app.retries,
    });
  } else if (failed) {
    findings.push({
      kind: "syncFailedOnce",
      severity: "err",
      message,
      since: app.lastSyncAt,
    });
  } else if (app.sync === "OutOfSync" && !app.autoSync) {
    // The quiet one. Nothing is failing, nothing is retrying, and nothing
    // will change until a person acts.
    findings.push({ kind: "drifted", severity: "warn", since: app.lastSyncAt });
  }

  if (app.health === "Degraded") {
    findings.push({
      kind: "degraded",
      severity: "err",
      message: app.healthMessage,
      resources: app.resources.filter(
        (resource) => resource.health === "Degraded"
      ),
    });
  }

  for (const condition of app.conditions) {
    // `SyncError` restates the refusal the operation already reported, with
    // less context around it. Where the sync failure is already a finding,
    // the condition is the same sentence a second time.
    if (failed && condition.type === "SyncError") continue;
    findings.push({
      kind: "condition",
      severity: CONDITION_ERRORS.some((word) => condition.type.includes(word))
        ? "err"
        : "warn",
      condition,
    });
  }

  return findings;
}

function worstOf(findings: ArgoFinding[]): "err" | "warn" | null {
  if (findings.some((finding) => finding.severity === "err")) return "err";
  if (findings.length > 0) return "warn";
  return null;
}

/** The resources that do not match git — the answer the reader came for. */
export function differing(app: ArgoApp): ArgoResource[] {
  return app.resources.filter(
    (resource) => resource.sync !== null && resource.sync !== "Synced"
  );
}

/** How much attention one managed object has earned, lower being worse. */
function rankOf(resource: ArgoResource): number {
  if (resource.outcome === "SyncFailed") return 0;
  if (resource.sync === "Missing") return 1;
  if (resource.health === "Degraded") return 2;
  if (resource.sync !== null && resource.sync !== "Synced") return 3;
  if (resource.health === "Progressing") return 4;
  return 5;
}

export interface ResourceKindGroup {
  kind: string;
  resources: ArgoResource[];
  /** How many of them are anything other than synced and healthy. */
  troubled: number;
}

/**
 * Everything an Application manages, grouped by kind.
 *
 * The page used to draw a count — "17 objects" — and then list only the ones
 * that differed. A healthy Application therefore said how many things it
 * owned and never which, which is the wrong half: *what is in this
 * Application* is the question somebody opens it with, and the objects are
 * already in `status.resources` with their own health beside them.
 *
 * Kinds are ordered by trouble and then alphabetically, and so are the
 * objects inside each one, because a hundred-object Helm release is the
 * ordinary case and the two that are failing must not be somewhere in the
 * middle of it.
 */
export function byKind(resources: ArgoResource[]): ResourceKindGroup[] {
  const groups = new Map<string, ArgoResource[]>();
  for (const resource of resources) {
    groups.set(resource.kind, [...(groups.get(resource.kind) ?? []), resource]);
  }

  return [...groups.entries()]
    .map(([kind, list]): ResourceKindGroup => ({
      kind,
      resources: [...list].sort(
        (left, right) =>
          rankOf(left) - rankOf(right) || left.name.localeCompare(right.name)
      ),
      troubled: list.filter((resource) => rankOf(resource) < 5).length,
    }))
    .sort((left, right) => {
      const worst = (group: ResourceKindGroup) =>
        Math.min(...group.resources.map(rankOf));
      return worst(left) - worst(right) || left.kind.localeCompare(right.kind);
    });
}

/** Whether this object is worth colouring, and how. */
export function resourceTone(resource: ArgoResource): "err" | "warn" | null {
  const rank = rankOf(resource);
  if (rank <= 2) return "err";
  if (rank <= 4) return "warn";
  return null;
}

/**
 * The word at the right of a row.
 *
 * Deliberately close to Argo's own vocabulary, and deliberately not the thing
 * that distinguishes the two findings — because in Argo's vocabulary they are
 * the same word. The tone separates them at a glance and the finding says
 * which is which; a status column that claimed to tell them apart would be
 * inventing a word Argo does not have.
 */
export function appState(app: ArgoApp, t: T): VendorVerdict {
  const words = [
    app.sync === "Synced"
      ? t("readings", "argoSynced")
      : app.sync === "OutOfSync"
        ? t("readings", "argoOutOfSync")
        : t("readings", "argoNotCompared"),
    app.health.toLowerCase(),
  ];
  return {
    text: words.join(" · "),
    tone: app.worst ?? (app.health === "Progressing" ? "warn" : "ok"),
  };
}

/** Trouble first, then the alphabet, so a reload never reshuffles the list. */
export function byTrouble(apps: ArgoApp[]): ArgoApp[] {
  const rank = (app: ArgoApp) =>
    app.worst === "err" ? 0 : app.worst === "warn" ? 1 : 2;
  return [...apps].sort(
    (left, right) =>
      rank(left) - rank(right) || left.name.localeCompare(right.name)
  );
}

/** How many namespaces an Application actually writes into. */
export function destinationOf(app: ArgoApp, t: T): string {
  const namespaces = new Set(
    app.resources
      .map((resource) => resource.namespace)
      .filter((namespace): namespace is string => Boolean(namespace))
  );
  if (app.destination.namespace) namespaces.add(app.destination.namespace);
  if (namespaces.size === 0)
    return app.destination.server ?? t("readings", "argoThisCluster");
  if (namespaces.size === 1) return [...namespaces][0];
  return t("readings", "argoNamespaceCount", { n: namespaces.size });
}
