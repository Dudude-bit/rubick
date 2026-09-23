/**
 * What a route's status says about one parent, read one way on every screen.
 *
 * Several controllers can write an entry for the same parent. The trace read
 * the first `Accepted` it found, the graph the first entry, and the Gateway
 * page, the map and the peek let any refusal decide — so a route two
 * controllers disagreed about was green on one screen and red beside it.
 * `shared/route-verdict-conformance.json` holds this file and
 * `resources/gateway.rs` to one answer.
 */

import type {
  ConditionInfo,
  ParentRefInfo,
  RouteParentStatusInfo,
} from "@/generated/types";

export type Verdict =
  /** No entry for this parent at all. */
  | { state: "none" }
  /** Entries, none of which carries the condition. */
  | { state: "undecided" }
  | { state: "false" | "pending" | "true"; said: ConditionInfo };

type ParentKey = Pick<
  ParentRefInfo,
  "group" | "kind" | "name" | "namespace" | "sectionName" | "port"
>;

/** An entry naming a different listener or port is another attachment's. */
const fits = <V>(said: V | null | undefined, asked: V | null | undefined) =>
  said == null || asked == null || said === asked;

/**
 * The entries that answer for one parentRef. A status parentRef echoes the
 * spec's, sectionName included — a route attached through two listeners has
 * two verdicts, and each must read its own. Entries that name no section, or
 * a controller that did not echo it, answer for every attachment. Narrowing
 * to the exact ones is per controller: one that echoed the listener must not
 * silence another that did not.
 */
export function statusesFor<
  E extends Pick<RouteParentStatusInfo, "parent" | "controllerName">,
>(route: { namespace: string; parents: E[] }, parent: ParentKey): E[] {
  // A Gateway and a ListenerSet may share a name; each is its own parent.
  const named = route.parents.filter(
    (entry) =>
      entry.parent.group === parent.group &&
      entry.parent.kind === parent.kind &&
      entry.parent.name === parent.name &&
      (entry.parent.namespace ?? route.namespace) ===
        (parent.namespace ?? route.namespace) &&
      fits(entry.parent.sectionName, parent.sectionName) &&
      fits(entry.parent.port, parent.port)
  );
  const exact = (entry: E) =>
    (entry.parent.sectionName ?? null) === (parent.sectionName ?? null) &&
    (entry.parent.port ?? null) === (parent.port ?? null);
  const echoed = new Set(
    named.filter(exact).map((entry) => entry.controllerName)
  );
  return named.filter(
    (entry) => exact(entry) || !echoed.has(entry.controllerName)
  );
}

/** One refusal decides; True only when every entry says True. */
export function verdictOf(
  entries: { conditions: ConditionInfo[] }[],
  type: "Accepted" | "ResolvedRefs"
): Verdict {
  if (entries.length === 0) return { state: "none" };
  const said = entries.flatMap((entry) =>
    entry.conditions.filter((c) => c.type === type)
  );
  if (said.length === 0) return { state: "undecided" };
  const refused = said.find((c) => c.status === "False");
  if (refused) return { state: "false", said: refused };
  const undecided = said.find((c) => c.status !== "True");
  if (undecided) return { state: "pending", said: undecided };
  // The oldest generation speaks: a staleness badge must not hide behind a
  // fresher controller's answer.
  const oldest = said.reduce((sofar, c) =>
    c.observedGeneration != null &&
    (sofar.observedGeneration == null ||
      c.observedGeneration < sofar.observedGeneration)
      ? c
      : sofar
  );
  return { state: "true", said: oldest };
}

/** The condition that decided, where one did. */
export function saidOf(verdict: Verdict): ConditionInfo | undefined {
  return "said" in verdict ? verdict.said : undefined;
}
