/**
 * What a NetworkPolicy does, in the terms a reader is shown it in.
 *
 * A NetworkPolicy is the one core kind where the object's shape and its
 * effect come apart. `ingress: []` and `ingress: [{}]` are one character
 * apart and are opposites; a `podSelector` that matches nothing is accepted,
 * listed, and protects nothing; and a direction absent from `policyTypes` is
 * one this policy makes no claim about at all. Every question below is asked
 * here so the list, the detail page and their tests give one answer.
 */

import type { T as Translator } from "@/i18n/useT";
import type {
  PolicyDirection,
  PolicyPeer,
  PolicyPort,
  PolicySelects,
} from "@/generated/types";

/** What a policy does in one direction, as one of four answers. */
export type DirectionVerdict =
  "notGoverned" | "deniesEverything" | "opensToEverything" | "restricts";

export function verdictOf(direction: PolicyDirection): DirectionVerdict {
  if (!direction.governed) return "notGoverned";
  if (direction.rules.length === 0) return "deniesEverything";
  if (direction.opensToEverything) return "opensToEverything";
  return "restricts";
}

/** How many pods the policy picks, with the read that never happened kept. */
export type Reach =
  { kind: "cannotSay" } | { kind: "nothing" } | { kind: "pods"; count: number };

/**
 * `null` is a pod list this reader was refused, and it is not zero. Zero is
 * the finding the page exists for — a policy nobody is behind — and handing
 * it to someone who simply lacks `list pods` would invent it.
 */
export function reachOf(selected: number | null): Reach {
  if (selected === null) return { kind: "cannotSay" };
  if (selected === 0) return { kind: "nothing" };
  return { kind: "pods", count: selected };
}

/**
 * Whether a peer's two selectors are both written, which is the AND.
 *
 * `podSelector` and `namespaceSelector` in one peer mean those pods *in*
 * those namespaces. In two peers they mean either. Drawing the first as two
 * lines widens a rule in the direction that opens the cluster.
 */
export function isIntersection(peer: PolicyPeer): boolean {
  return peer.pods.kind !== "notSaid" && peer.namespaces.kind !== "notSaid";
}

/**
 * What a peer's `namespaceSelector` reaches. Absent is not "no namespaces":
 * it is the policy's own, which is the narrowest answer, while an empty one
 * is every namespace in the cluster, which is the widest. The same three
 * shapes mean the opposite thing here than they do on `spec.podSelector`,
 * which is why each axis is read by its own function rather than by one
 * renderer over `PolicySelects`.
 */
export type PeerNamespaces =
  | { kind: "ownNamespace" }
  | { kind: "everyNamespace" }
  | { kind: "written"; query: string };

export function namespacesOf(selects: PolicySelects): PeerNamespaces {
  switch (selects.kind) {
    case "notSaid":
      return { kind: "ownNamespace" };
    case "everything":
      return { kind: "everyNamespace" };
    case "written":
      return { kind: "written", query: selects.query };
  }
}

/** What a peer's `podSelector` reaches, on the axis where absent is wide. */
export type PeerPods =
  { kind: "everyPod" } | { kind: "written"; query: string };

export function podsOf(selects: PolicySelects): PeerPods {
  switch (selects.kind) {
    case "notSaid":
    case "everything":
      return { kind: "everyPod" };
    case "written":
      return { kind: "written", query: selects.query };
  }
}

/** One direction's verdict, in the words and the tone the row deserves. */
export function directionFact(
  direction: PolicyDirection,
  t: Translator
): { value: string; tone?: "warn" } {
  switch (verdictOf(direction)) {
    case "notGoverned":
      return { value: t("empty", "saysNothing") };
    case "deniesEverything":
      return { value: t("empty", "deniesAll") };
    case "opensToEverything":
      return { value: t("empty", "allowsAll"), tone: "warn" };
    case "restricts":
      return {
        value: t("count", "rules", { n: direction.rules.length }),
      };
  }
}

export function portText(port: PolicyPort): string {
  const range = port.endPort ? `${port.port}-${port.endPort}` : port.port;
  return `${port.protocol}/${range}`;
}

/**
 * One peer, with the AND kept visible.
 *
 * The two selectors inside a single peer are an intersection — those pods in
 * those namespaces — and the word between them is what says so. Two peers,
 * one selector each, are a union and are drawn as two rows.
 */
