/**
 * The three cells of the NetworkPolicy table.
 *
 * Their own file because each one draws a state that the state beside it
 * would be mistaken for, and because the columns array is exported for
 * `column-widths.test.ts` — a file that exports both a component and
 * something else loses fast refresh for the whole page.
 */

import type {
  NetworkPolicyInfo,
  PolicyDirection,
  PolicyPeer,
  PolicySelects,
} from "@/generated/types";
import { T } from "@/i18n/T";
import { parts } from "@/i18n/parts";
import { useT } from "@/i18n/useT";
import {
  directionWords,
  namespacesOf,
  podsOf,
  reachOf,
  reachWords,
  selectsWords,
  verdictOf,
  type DirectionVerdict,
  type Reach,
} from "@/lib/network-policy";

/**
 * What each of the four answers looks like. A total map, so a fifth verdict
 * cannot be added without this failing to compile — the alternative is a
 * lookup with a fallback, which paints a new state neutral and says nothing.
 * The words are `directionWords`, which the shared file reads too.
 */
const VERDICT_TONE: Record<DirectionVerdict, string> = {
  // The policy says nothing about this direction; another policy may.
  notGoverned: "text-fg-fnt",
  deniesEverything: "text-fg-mid",
  // The one worth a colour: a governed direction with a rule that names no
  // peer is wide open, and it looks like a configured policy from every
  // other screen.
  opensToEverything: "text-warn",
  restricts: "text-fg-mut",
};

export function DirectionCell({ direction }: { direction: PolicyDirection }) {
  const t = useT();
  return (
    <span className={VERDICT_TONE[verdictOf(direction)]}>
      {directionWords(direction, t).text}
    </span>
  );
}

/**
 * `cannotSay` is not a zero and not a blank: the pods were never read. A
 * policy behind no pod at all is the finding this page exists for — accepted,
 * listed, enforcing nothing, and every other screen shows the namespace as
 * protected.
 */
const REACH_TONE: Record<Reach["kind"], string> = {
  cannotSay: "text-fg-fnt",
  nothing: "text-warn",
  pods: "text-fg-mut",
};

export function ReachCell({ policy }: { policy: NetworkPolicyInfo }) {
  const t = useT();
  return (
    <span className={REACH_TONE[reachOf(policy.selected).kind]}>
      {reachWords(policy.selected, t).text}
    </span>
  );
}

/**
 * The widest thing a NetworkPolicy can say, `everything`, would read as the
 * narrowest row on the page as a blank cell.
 */
const SELECTS_TONE: Record<PolicySelects["kind"], string> = {
  everything: "text-fg-mid",
  written: "font-mono text-fg-mid",
  notSaid: "text-fg-fnt",
};

export function SelectsCell({ policy }: { policy: NetworkPolicyInfo }) {
  const t = useT();
  return (
    <span className={SELECTS_TONE[policy.selects.kind]}>
      {selectsWords(policy.selects, t)}
    </span>
  );
}

export function Peer({ peer }: { peer: PolicyPeer }) {
  const t = useT();
  if (peer.ipBlock) {
    return (
      <span className="font-mono text-fg-mid">
        {peer.ipBlock.cidr}
        {peer.ipBlock.except.length > 0 && (
          <span className="font-sans text-fg-fnt">
            {" "}
            <T
              section="empty"
              k="exceptRanges"
              values={{ ranges: peer.ipBlock.except.join(", ") }}
            />
          </span>
        )}
      </span>
    );
  }

  const pods = podsOf(peer.pods);
  const namespaces = namespacesOf(peer.namespaces);
  const podNode = (
    <span className={pods.kind === "written" ? "font-mono" : undefined}>
      {pods.kind === "written" ? pods.query : t("empty", "everyPodThere")}
    </span>
  );
  const namespaceNode = (
    <span className={namespaces.kind === "written" ? "font-mono" : undefined}>
      {namespaces.kind === "written"
        ? namespaces.query
        : namespaces.kind === "everyNamespace"
          ? t("empty", "inEveryNamespace")
          : t("empty", "inThisNamespace")}
    </span>
  );

  // Always "in", because the two selectors of one peer are always an AND:
  // those pods, *in* those namespaces. The OR is between peers, and peers
  // are already separate lines. Picking a second sentence for a peer that
  // names only one of the two read it as unscoped, which is the direction
  // that opens the cluster.
  return (
    <span className="text-fg-mid">
      {parts(t("empty", "podsInNamespaces"), {
        pods: podNode,
        namespaces: namespaceNode,
      })}
    </span>
  );
}
