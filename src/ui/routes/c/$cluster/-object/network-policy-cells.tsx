/**
 * The three cells of the NetworkPolicy table.
 *
 * Their own file because each one draws a state that the state beside it
 * would be mistaken for, and because the columns array is exported for
 * `column-widths.test.ts` — a file that exports both a component and
 * something else loses fast refresh for the whole page.
 */

import { Link } from "@tanstack/react-router";
import type { MouseEvent } from "react";

import type {
  NetworkPolicyInfo,
  PolicyDirection,
  PolicyPeer,
  PolicySelects,
} from "@/generated/types";
import { ResourceRef } from "@/components/object/ResourceRef";
import { usePolicyPeerData, type PeerData } from "@/hooks/usePolicyPeers";
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
import { selectedPodsLink } from "@/lib/links";
import { leavesNamespace, peerMatch } from "@/lib/policy-peers";

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
  const verdict = verdictOf(direction);
  const words = directionWords(direction, t).text;
  return (
    <span className={VERDICT_TONE[verdict]} title={words}>
      {verdict === "notGoverned" ? t("empty", "notRestricted") : words}
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
  const reach = reachOf(policy.selected);
  const text = reachWords(policy.selected, t).text;
  const query =
    policy.selects.kind === "written"
      ? policy.selects.query
      : policy.selects.kind === "everything"
        ? ""
        : null;
  if (reach.kind === "pods" && query !== null) {
    return (
      <PodsLink selector={query} namespaces={[policy.namespace]}>
        {text}
      </PodsLink>
    );
  }
  return <span className={REACH_TONE[reach.kind]}>{text}</span>;
}

/** Inside a table row, a link opens its own address and not the row's peek. */
const keepToItself = (event: MouseEvent) => event.stopPropagation();

/** The Pods list narrowed to these pods. */
export function PodsLink({
  selector,
  namespaces,
  children,
}: {
  selector: string;
  namespaces: string[] | null;
  children: string;
}) {
  return (
    <Link
      {...selectedPodsLink(selector, namespaces)}
      onClick={keepToItself}
      className="text-info underline-offset-2 hover:underline"
    >
      {children}
    </Link>
  );
}

/** How many namespace names are drawn before the rest become a count. */
const NAMESPACES_SHOWN = 3;

/**
 * What one peer reaches, resolved: the pods it names, with a link to them,
 * and the namespaces when it leaves the policy's own. An IP block names no
 * pod and stays the CIDR the line above already prints.
 */
export function PeerReach({
  peer,
  home,
  data,
}: {
  peer: PolicyPeer;
  home: string;
  data: PeerData;
}) {
  const t = useT();
  const match = peerMatch(
    peer,
    home,
    leavesNamespace(peer) ? data.cluster : data.home,
    data.namespaces
  );
  switch (match.kind) {
    case "ipBlock":
      return null;
    case "unevaluable":
      return (
        <span className="text-[11px] text-warn">
          {t("empty", "peerCannotEvaluate")}
        </span>
      );
    case "cannotSay":
      return (
        <span
          className="text-[11px] text-fg-fnt"
          title={match.why ?? undefined}
        >
          {match.why === null
            ? t("readings", "healthStillReading")
            : t("empty", "peerPodsNotRead")}
        </span>
      );
    case "matched": {
      const others =
        match.namespaces &&
        !(match.namespaces.length === 1 && match.namespaces[0] === home)
          ? match.namespaces
          : null;
      return (
        <span className="inline-flex flex-wrap items-baseline gap-x-1.5 text-[11px]">
          <span aria-hidden className="text-fg-fnt">
            →
          </span>
          {match.pods.length === 0 ? (
            <span className="text-warn">{t("empty", "noPodMatches")}</span>
          ) : (
            <PodsLink
              selector={match.selector ?? ""}
              namespaces={match.namespaces}
            >
              {t("empty", "podsMatching", { n: match.pods.length })}
            </PodsLink>
          )}
          {others && (
            <span className="inline-flex flex-wrap items-baseline gap-x-1 text-fg-mut">
              {t("empty", "inNamespacesCount", { n: others.length })}
              {others.slice(0, NAMESPACES_SHOWN).map((name) => (
                <ResourceRef
                  key={name}
                  kind="Namespace"
                  name={name}
                  showKind={false}
                />
              ))}
              {others.length > NAMESPACES_SHOWN && (
                <span className="text-fg-fnt">
                  {t("count", "plusMore", {
                    n: others.length - NAMESPACES_SHOWN,
                  })}
                </span>
              )}
            </span>
          )}
        </span>
      );
    }
  }
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

/**
 * A rule's peers, each with what it resolves to, for a surface that holds
 * one rule at a time. The reads come from the shared caches, so a peek of
 * ten rules is still one read of each list.
 */
export function ResolvedPeers({
  peers,
  home,
}: {
  peers: PolicyPeer[];
  home: string;
}) {
  const data = usePolicyPeerData(home, {
    cluster: peers.some(leavesNamespace),
    namespaces: peers.some((peer) => peer.namespaces.kind === "written"),
  });
  return (
    <span className="flex flex-col gap-0.5">
      {peers.map((peer, i) => (
        <span key={i} className="flex flex-wrap items-baseline gap-x-2">
          <Peer peer={peer} />
          <PeerReach peer={peer} home={home} data={data} />
        </span>
      ))}
    </span>
  );
}
