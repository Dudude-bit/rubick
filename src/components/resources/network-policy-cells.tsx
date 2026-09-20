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
} from "@/generated/types";
import { T } from "@/i18n/T";
import { parts } from "@/i18n/parts";
import { useT } from "@/i18n/useT";
import {
  namespacesOf,
  podsOf,
  reachOf,
  verdictOf,
  type DirectionVerdict,
} from "@/lib/network-policy";

/**
 * What each of the four answers looks like. A total map, so a fifth verdict
 * cannot be added without this failing to compile — the alternative is a
 * lookup with a fallback, which paints a new state neutral and says nothing.
 */
const VERDICT: Record<DirectionVerdict, { k: string; tone: string }> = {
  // The policy says nothing about this direction; another policy may.
  notGoverned: { k: "saysNothing", tone: "text-fg-fnt" },
  deniesEverything: { k: "deniesAll", tone: "text-fg-mid" },
  // The one worth a colour: a governed direction with a rule that names no
  // peer is wide open, and it looks like a configured policy from every
  // other screen.
  opensToEverything: { k: "allowsAll", tone: "text-warn" },
  restricts: { k: "", tone: "text-fg-mut" },
};

export function DirectionCell({ direction }: { direction: PolicyDirection }) {
  const verdict = verdictOf(direction);
  const { k, tone } = VERDICT[verdict];
  return (
    <span className={tone}>
      {verdict === "restricts" ? (
        <T section="count" k="rules" values={{ n: direction.rules.length }} />
      ) : (
        <T section="empty" k={k as "deniesAll"} />
      )}
    </span>
  );
}

export function ReachCell({ policy }: { policy: NetworkPolicyInfo }) {
  const reach = reachOf(policy.selected);
  switch (reach.kind) {
    // Not a zero, and not a blank: the pods were never read, so this page
    // has no number to give and says which of the two it is.
    case "cannotSay":
      return (
        <span className="text-fg-fnt">
          <T section="empty" k="podsNotRead" />
        </span>
      );
    // The finding this page exists for. A policy behind no pod at all is
    // accepted by the API server, listed like any other, and enforces
    // nothing — every other screen shows the namespace as protected.
    case "nothing":
      return (
        <span className="text-warn">
          <T section="empty" k="selectsNoPods" />
        </span>
      );
    case "pods":
      return (
        <span className="text-fg-mut">
          <T section="count" k="pods" values={{ n: reach.count }} />
        </span>
      );
  }
}

export function SelectsCell({ policy }: { policy: NetworkPolicyInfo }) {
  switch (policy.selects.kind) {
    // The widest thing a NetworkPolicy can say, and as a blank cell it would
    // read as the narrowest row on the page.
    case "everything":
      return (
        <span className="text-fg-mid">
          <T section="empty" k="everyPodHere" />
        </span>
      );
    case "written":
      return (
        <span className="font-mono text-fg-mid">{policy.selects.query}</span>
      );
    case "notSaid":
      return (
        <span className="text-fg-fnt">
          <T section="empty" k="noSelectorOnPolicy" />
        </span>
      );
  }
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
