/**
 * What acts on an object without the object having asked, and what that
 * means for the reader right now.
 *
 * Two kinds live here, and they are together because they are the same shape
 * of fact: a HorizontalPodAutoscaler and a PodDisruptionBudget are both
 * written by somebody else, about this workload, and neither of them leaves a
 * trace on the workload's own YAML. Nothing on a Deployment says "an HPA
 * overwrites `spec.replicas` fifteen seconds after you set it", and nothing on
 * it says "a node drain will block on this".
 *
 * The whole module is pure: it reads the `governs` edges the connections call
 * already returned and turns them into sentences. Nothing here fetches, and
 * nothing here re-derives a number the cluster already published — an
 * autoscaler's own arithmetic is the one thing this must never repeat, because
 * the app's answer and the controller's would disagree the moment a scaling
 * policy is involved.
 *
 * ## Why the HPA's target is not one of the Usage rows
 *
 * The Usage rows on a workload draw live usage summed over every replica
 * against the *limits* summed over every replica. An HPA's target is a
 * per-pod mean against the *request*. Different denominator, different
 * aggregation, and — the part that decides it — a different kind of number:
 * a limit is a ceiling the kernel enforces, and crossing an HPA target does
 * not throttle anything, it adds a pod. Drawing the target as a mark on that
 * bar would put two incompatible fractions on one axis, wrong by whatever the
 * limit-to-request ratio happens to be. So the reading stays here, next to
 * the target it is actually compared against.
 */

import type { T } from "@/i18n/useT";
import { load } from "js-yaml";

import type {
  ConditionInfo,
  ObjectFacts,
  ObjectRef,
  Relation,
  ResourceConnections,
} from "@/generated/types";
import type { DeliveryIntercept } from "./delivery";
import { formatAge } from "./utils";

export type AutoscalerFacts = Extract<ObjectFacts, { kind: "autoscaler" }>;
export type BudgetFacts = Extract<ObjectFacts, { kind: "budget" }>;

export interface Autoscaler {
  object: ObjectRef;
  facts: AutoscalerFacts;
  /** What it scales — the workload, even when read from a pod's page. */
  target: ObjectRef;
}

export interface Budget {
  object: ObjectRef;
  facts: BudgetFacts;
  /** What its selector matched: a workload, or one pod on a node. */
  covers: ObjectRef;
  selector: string | null;
}

/**
 * How loud a finding is allowed to be.
 *
 * `neutral` is not a lesser warning, it is a different claim: the fact is
 * true and worth reading and the cluster is not in trouble. Every
 * `DisruptionAllowed=False` on a healthy two-replica workload is one of
 * these, which is exactly the judgement `condition-health.ts` already makes
 * about the condition itself.
 */
export interface Finding {
  tone: "err" | "warn" | "neutral";
  title: string;
  detail: string;
}

const governs = (conns: ResourceConnections) =>
  conns.edges.filter(
    (
      edge
    ): edge is typeof edge & {
      relation: Extract<Relation, { verb: "governs" }>;
    } => edge.relation.verb === "governs"
  );

/** Every autoscaler that named something in this neighbourhood. */
export function autoscalers(conns: ResourceConnections): Autoscaler[] {
  return governs(conns).flatMap((edge) =>
    edge.from.facts?.kind === "autoscaler"
      ? [{ object: edge.from, facts: edge.from.facts, target: edge.to }]
      : []
  );
}

/** Every disruption budget whose selector matched something here. */
export function budgets(conns: ResourceConnections): Budget[] {
  return governs(conns).flatMap((edge) =>
    edge.from.facts?.kind === "budget"
      ? [
          {
            object: edge.from,
            facts: edge.from.facts,
            covers: edge.to,
            selector: edge.relation.selector,
          },
        ]
      : []
  );
}

const condition = (
  conditions: ConditionInfo[],
  type: string
): ConditionInfo | undefined =>
  conditions.find((c) => c.type.toLowerCase() === type.toLowerCase());

const isTrue = (c: ConditionInfo | undefined) => c?.status === "True";
const isFalse = (c: ConditionInfo | undefined) => c?.status === "False";

/**
 * A controller's message, made into a sentence that another can follow.
 *
 * Kubernetes writes condition messages as lower-case clauses with no full
 * stop — "the desired replica count is more than the maximum replica count" —
 * which is fine alone and runs straight into the next sentence when anything
 * is appended to it. Quoting it verbatim is still the right call: the words
 * are the controller's and paraphrasing them loses the search term.
 */
function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  const ended = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  return ended[0].toUpperCase() + ended.slice(1);
}

/** "1 to 5 replicas", or "pinned at 3" for the degenerate range. */
export function autoscalerRange(facts: AutoscalerFacts, t: T): string {
  return facts.minReplicas === facts.maxReplicas
    ? t("readings", "hpaPinnedAt", { n: facts.maxReplicas })
    : t("readings", "hpaRange", {
        min: facts.minReplicas,
        max: facts.maxReplicas,
      });
}

export interface MetricReading {
  key: string;
  /** "cpu", or "cpu in web" for a per-container target. */
  label: string;
  /** Where the number comes from, named only where it is not the obvious one. */
  from: string | null;
  target: string;
  /** `null` where the autoscaler published no reading at all. */
  current: string | null;
}

export function metricReadings(facts: AutoscalerFacts): MetricReading[] {
  return facts.metrics.map((metric, at) => ({
    key: `${metric.source}/${metric.name}/${at}`,
    label: metric.name,
    from:
      metric.source === "resource" || metric.source === "containerResource"
        ? null
        : `${metric.source} metric`,
    target: metric.target,
    current: metric.current,
  }));
}

/**
 * The one thing worth saying about an autoscaler, or nothing.
 *
 * Ordered by what stops the autoscaler working soonest. An HPA that cannot
 * reach the thing it scales has not got as far as reading a metric, and an
 * HPA that cannot read a metric never gets as far as being limited — so the
 * first true one is the whole answer and the rest is detail.
 */
export function autoscalerFinding(auto: Autoscaler, t: T): Finding | null {
  const { conditions } = auto.facts;
  const able = condition(conditions, "AbleToScale");
  const active = condition(conditions, "ScalingActive");
  const limited = condition(conditions, "ScalingLimited");
  const name = auto.object.name;

  if (isFalse(able)) {
    return {
      tone: "err",
      title: t("readings", "hpaCannotReach", { name }),
      detail: able?.message
        ? sentence(able.message)
        : t("readings", "hpaCannotReachDetail", {
            kind: auto.target.kind,
            target: auto.target.name,
          }),
    };
  }

  if (isFalse(active)) {
    // Zero replicas is the one `ScalingActive=False` that is a setting rather
    // than a fault: an HPA deliberately stops at zero and waits to be scaled
    // up by hand, and colouring it red would fire on every idle workload.
    if (active?.reason === "ScalingDisabled") {
      return {
        tone: "neutral",
        title: t("readings", "hpaStandingBy", { name }),
        detail: active.message
          ? sentence(active.message)
          : t("readings", "hpaStandingByDetail"),
      };
    }
    return {
      tone: "err",
      title: t("readings", "hpaNoMetrics", { name }),
      detail: t("readings", "hpaNoMetricsDetail", {
        said: sentence(
          active?.message ??
            active?.reason ??
            t("readings", "hpaNoMetricsDefault")
        ),
      }),
    };
  }

  if (isTrue(limited)) {
    // `ScalingLimited` covers the floor, the ceiling and the stabilisation
    // window with one condition, and they are three different findings.
    // Reading the status word alone would call all three "limited".
    if (limited?.reason === "TooFewReplicas") {
      return {
        tone: "neutral",
        title: t("readings", "hpaAtFloor", {
          name,
          min: auto.facts.minReplicas,
        }),
        detail: t("readings", "hpaAtFloorDetail"),
      };
    }
    if (limited?.reason === "ScaleDownStabilized") {
      return null;
    }
    return {
      tone: "warn",
      title: t("readings", "hpaAtCeiling", {
        name,
        max: auto.facts.maxReplicas,
      }),
      detail: t("readings", "hpaAtCeilingDetail", {
        said: sentence(
          limited?.message ?? t("readings", "hpaAtCeilingDefault")
        ),
      }),
    };
  }

  return null;
}

/**
 * "2 running · 2 wanted", and the one case where the second half is a lie.
 *
 * An autoscaler that failed to compute leaves `status.desiredReplicas` at
 * zero — not because it wants zero replicas, but because it never got as far
 * as wanting anything. Printing "0 wanted" beside a running workload is the
 * worst number on the page: it reads as an autoscaler about to delete
 * everything, and it is the field being unset.
 */
export function autoscalerReplicas(facts: AutoscalerFacts, t: T): string {
  const computed = !isFalse(condition(facts.conditions, "ScalingActive"));
  const parts = [
    t("readings", "hpaRunning", { n: facts.currentReplicas }),
    computed
      ? t("readings", "hpaWanted", { n: facts.desiredReplicas })
      : t("readings", "hpaNothingComputed"),
  ];
  if (facts.lastScaleTime)
    parts.push(
      t("readings", "hpaLastScaled", { ago: formatAge(facts.lastScaleTime, t) })
    );
  return parts.join(" · ");
}

/**
 * When the count last moved, or nothing where it never has.
 *
 * Split out of {@link autoscalerReplicas} because the replica numbers beside
 * it belong to the workload's own block now, and this clause does not: it is
 * the one thing the autoscaler knows that the count itself cannot say.
 */
export function lastScaled(facts: AutoscalerFacts, t: T): string | null {
  return facts.lastScaleTime
    ? t("readings", "hpaLastScaled", { ago: formatAge(facts.lastScaleTime, t) })
    : null;
}

/** "at least 1 available" / "at most 1 unavailable". */
export function budgetRule(facts: BudgetFacts, t: T): string {
  if (facts.minAvailable !== null)
    return t("readings", "pdbAtLeast", { n: facts.minAvailable });
  if (facts.maxUnavailable !== null)
    return t("readings", "pdbAtMost", { n: facts.maxUnavailable });
  return t("readings", "pdbNoRule");
}

/**
 * How much room the budget is leaving, right now.
 *
 * `expectedPods` is how many pods the *selector* matched, not a target — a
 * selector that also catches thirteen evicted pods reports fifteen, and
 * "2 of 15 healthy" reads as a workload in ruins. "of 15 selected" says the
 * denominator is a match count, which is what it is.
 */
export function budgetRoom(facts: BudgetFacts, t: T): string {
  const allowed =
    facts.disruptionsAllowed === 0
      ? t("readings", "pdbNoDisruption")
      : t("count", "disruptionsAllowed", { n: facts.disruptionsAllowed });
  return t("readings", "pdbRoom", {
    allowed,
    healthy: facts.currentHealthy,
    selected: facts.expectedPods,
  });
}

/**
 * What a budget is worth saying, and — mostly — how loudly it is not.
 *
 * `disruptionsAllowed == 0` is the fact a drain runs into, and it is also
 * the **normal** state of a one-replica workload with `minAvailable: 1`, or a
 * two-replica one with `minAvailable: 2`. Painting that red claims a fault
 * the cluster never reported, which is the same mistake
 * `condition-health.ts` made with `DisruptionAllowed=False` and fixed by
 * calling the condition advisory.
 *
 * So the fact is always stated and the colour is earned by one thing: whether
 * the budget is *spent* or *broken*. A budget exactly met — as many healthy
 * pods as it demands — is spent, and one more ready replica frees it; that is
 * the budget doing its job and it gets no colour. A budget below its own
 * floor is broken: the drain blocks *and* the workload is already short, so
 * nothing is going to free it until the workload recovers. That earns a
 * warning, and it is a warning about the workload rather than about the
 * budget.
 */
export function budgetFinding(budget: Budget, t: T): Finding | null {
  const facts = budget.facts;
  if (facts.disruptionsAllowed > 0) return null;

  const short = facts.currentHealthy < facts.desiredHealthy;
  if (short) {
    return {
      tone: "warn",
      title: t("readings", "pdbBelowFloor", {
        name: budget.object.name,
        healthy: facts.currentHealthy,
        required: facts.desiredHealthy,
      }),
      detail: t("readings", "pdbBelowFloorDetail"),
    };
  }

  return {
    tone: "neutral",
    title: t("readings", "pdbExactlyMet", { name: budget.object.name }),
    detail: t("readings", "pdbExactlyMetDetail", {
      healthy: facts.currentHealthy,
      required: facts.desiredHealthy,
    }),
  };
}

// --- the moment a budget actually matters -------------------------------

export interface DrainBlocker {
  budget: Budget;
  /** How many pods on this node the budget covers. */
  pods: number;
}

/**
 * The budgets on this node that will refuse the first eviction.
 *
 * A drain is where a PodDisruptionBudget stops being a number on a page and
 * becomes the thing that makes the command hang: `kubectl drain` does not
 * fail on a spent budget, it retries, and a reader who does not know which
 * budget is holding it has no way to tell a slow drain from a stuck one.
 *
 * Deduplicated by budget rather than listed per pod: one budget covering
 * four pods on this node is one reason, and four identical lines would be a
 * count dressed up as a list.
 */
export function drainBlockers(
  conns: ResourceConnections | undefined
): DrainBlocker[] {
  if (!conns) return [];
  const byBudget = new Map<string, DrainBlocker>();
  for (const budget of budgets(conns)) {
    if (budget.facts.disruptionsAllowed > 0) continue;
    const key = `${budget.object.namespace}/${budget.object.name}`;
    const seen = byBudget.get(key);
    if (seen) seen.pods += 1;
    else byBudget.set(key, { budget, pods: 1 });
  }
  return [...byBudget.values()];
}

// --- at the point of action ---------------------------------------------

/**
 * One reason the replica count you are about to set will not stay set.
 *
 * The same shape delivery's intercept produces, so the Scale dialog can hold
 * two of them without knowing which kind either one is. `subject` is the
 * three-word noun that heads a stacked line — with two warnings the dialog
 * needs to say *what* is doing it before it says what will happen, or the two
 * paragraphs read as one long complaint.
 */
export interface ActionWarning {
  key: string;
  subject: string;
  /** The clause that has to be read, in six words. */
  lead: string;
  description: string;
  /** Where the change would really have to be made, where there is a page. */
  to: string | null;
}

/**
 * What the autoscalers on this object will do to a hand-set replica count.
 *
 * Three cases, and the middle one is the reason this is not a boolean:
 *
 * - one autoscaler, working — the number goes back within about fifteen
 *   seconds, and the honest instruction is to change the bounds instead;
 * - one autoscaler that cannot currently act — the number *stands*, and
 *   saying "this will be undone" would be a lie the reader can check. It
 *   stands until the metrics come back, which is worth knowing precisely
 *   because nothing announces that moment;
 * - several autoscalers on one workload — a real state, and not one that may
 *   be drawn as a confident bound: each writes `spec.replicas` from its own
 *   reading and each undoes the other, so no range on the page is the range.
 */
export function autoscalerScaleWarnings(
  conns: ResourceConnections | undefined,
  t: T
): ActionWarning[] {
  if (!conns) return [];
  const found = autoscalers(conns);
  if (found.length === 0) return [];

  if (found.length > 1) {
    const names = found.map((auto) => auto.object.name).join(", ");
    return [
      {
        key: "hpa:several",
        subject: t("readings", "hpaSeveralTitle", { n: found.length }),
        lead: t("readings", "hpaSeveralHead", { n: found.length }),
        description: t("readings", "hpaSeveralDetail", { names }),
        to: null,
      },
    ];
  }

  const auto = found[0];
  const facts = auto.facts;
  const stalled =
    isFalse(condition(facts.conditions, "AbleToScale")) ||
    isFalse(condition(facts.conditions, "ScalingActive"));

  if (stalled) {
    const why =
      condition(facts.conditions, "ScalingActive")?.reason ??
      condition(facts.conditions, "AbleToScale")?.reason ??
      t("readings", "hpaCannotActNow");
    return [
      {
        key: `hpa:${auto.object.name}`,
        subject: t("readings", "hpaAutoscalerNamed", {
          name: auto.object.name,
        }),
        lead: t("readings", "hpaOwnsStuckHead", { name: auto.object.name }),
        description: t("readings", "hpaStuckDetail", {
          why,
          min: facts.minReplicas,
          max: facts.maxReplicas,
        }),
        to: null,
      },
    ];
  }

  return [
    {
      key: `hpa:${auto.object.name}`,
      subject: t("readings", "hpaAutoscalerNamed", { name: auto.object.name }),
      lead: t("readings", "hpaWillRevertHead", { name: auto.object.name }),
      description: t("readings", "hpaWillRevertDetail", {
        min: facts.minReplicas,
        max: facts.maxReplicas,
      }),
      to: null,
    },
  ];
}

/**
 * Everything that will move a replica count back, soonest first.
 *
 * The order is the order the reader will feel them: an autoscaler re-reads in
 * about fifteen seconds, a delivery controller reconciles in minutes. A
 * workload that has both is a real and unremarkable arrangement — an HPA in
 * git, applied by Argo — and the two of them do genuinely different things:
 * the HPA replaces the number, the controller replaces the *object*, taking
 * the number with it. Neither sentence is a rewording of the other, which is
 * what stops the pair from reading as noise.
 */
export function scaleWarnings(
  conns: ResourceConnections | undefined,
  intercept: DeliveryIntercept | null,
  t: T
): ActionWarning[] {
  return [...autoscalerScaleWarnings(conns, t), ...deliveryWarning(intercept)];
}

/** A delivery intercept as one of the stacked warnings, or none. */
export function deliveryWarning(
  intercept: DeliveryIntercept | null
): ActionWarning[] {
  if (!intercept) return [];
  return [
    {
      key: "delivery",
      subject: intercept.subject,
      lead: intercept.lead,
      description: intercept.description,
      to: intercept.where?.to ?? null,
    },
  ];
}

/**
 * Everything that will undo the manifest you are about to apply.
 *
 * ## Why the autoscaler is here only when the replica count moves
 *
 * The two causes are not the same size, and treating them as one would make
 * the dialog lie. A delivery controller re-applies the **whole object**, so
 * every field in the document is at risk and the warning is true whatever was
 * edited. An HPA owns exactly one field — `spec.replicas` — and says nothing
 * at all about an image tag, a resource limit or an env var. Warning about it
 * on every save would therefore be wrong on almost every save, and a dialog
 * that is wrong most of the time is a dialog people learn to dismiss without
 * reading; the next time it is right, it will be dismissed too.
 *
 * Never is the other wrong answer: a replica count typed into the YAML editor
 * is undone by the autoscaler exactly as fast as one typed into the Scale
 * dialog, and the app already warns there. The reader would learn that the
 * same edit is dangerous through one control and safe through another.
 *
 * So the rule is the diff: `changesReplicaCount` compares what the API server
 * had when the editor opened against what is about to be sent, and the
 * autoscaler is named when — and only when — that field is what moved.
 */
export function applyWarnings(
  conns: ResourceConnections | undefined,
  intercept: DeliveryIntercept | null,
  replicasMoved: boolean,
  t: T
): ActionWarning[] {
  return [
    ...(replicasMoved ? autoscalerScaleWarnings(conns, t) : []),
    ...deliveryWarning(intercept),
  ];
}

/**
 * Whether applying `edited` would set a different replica count from the one
 * `original` carried.
 *
 * `original` is what the API server had when the editor opened, so this is
 * true both when the reader typed a new number and when the document they are
 * about to send is stale — an autoscaler that moved the count under them
 * leaves a buffer whose `spec.replicas` will scale the workload back on apply,
 * which is a surprise worth the same sentence.
 *
 * A document that will not parse is not a replica change: the apply is about
 * to fail on its own and the API server's message is a better one than
 * anything guessed from here.
 */
export function changesReplicaCount(original: string, edited: string): boolean {
  const before = replicaCountIn(original);
  const after = replicaCountIn(edited);
  if (before === UNREADABLE || after === UNREADABLE) return false;
  return before !== after;
}

/** Distinguishes t("readings", "docNoReplicaCount") from t("readings", "cannotTell"). */
const UNREADABLE = Symbol("unreadable");

function replicaCountIn(text: string): number | null | typeof UNREADABLE {
  let doc: unknown;
  try {
    doc = load(text);
  } catch {
    return UNREADABLE;
  }
  if (!isRecord(doc)) return UNREADABLE;
  const spec = doc.spec;
  if (!isRecord(spec)) return null;
  return typeof spec.replicas === "number" ? spec.replicas : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
