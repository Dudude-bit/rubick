import { useQuery } from "@tanstack/react-query";
import {
  ShieldCheck,
  ShieldOff,
  ShieldQuestionMark,
  type LucideIcon,
} from "lucide-react";

import { ResourceRef } from "@/components/object/ResourceRef";
import { Section, SectionHeader } from "@/components/ui/section";
import type { PodInfo } from "@/generated/types";
import { useT, type T } from "@/i18n/useT";
import { commands } from "@/lib/commands";
import { knownOf } from "@/lib/known";
import { portText } from "@/lib/network-policy";
import {
  podPolicies,
  type Direction,
  type PodDirection,
} from "@/lib/policy-peers";
import { queryKeys } from "@/lib/query-keys";
import { ResourceType } from "@/lib/resource-registry";
import { STALE_TIMES } from "@/lib/refresh";
import { cn } from "@/lib/utils";
import { ResolvedPeers } from "../../../-object/network-policy-cells";

const LOOK: Record<PodDirection["state"], { icon: LucideIcon; tone: string }> =
  {
    open: { icon: ShieldOff, tone: "text-fg-mut" },
    isolated: { icon: ShieldCheck, tone: "text-ok" },
    cannotSay: { icon: ShieldQuestionMark, tone: "text-fg-fnt" },
  };

const WORD: Record<
  Direction,
  Record<
    PodDirection["state"],
    | "podIngressOpen"
    | "podIngressIsolated"
    | "podEgressOpen"
    | "podEgressIsolated"
    | "podPoliciesCannotSay"
  >
> = {
  ingress: {
    open: "podIngressOpen",
    isolated: "podIngressIsolated",
    cannotSay: "podPoliciesCannotSay",
  },
  egress: {
    open: "podEgressOpen",
    isolated: "podEgressIsolated",
    cannotSay: "podPoliciesCannotSay",
  },
};

/** `policyTypes` spells the two directions, and so does this card. */
const NAME: Record<Direction, "Ingress" | "Egress"> = {
  ingress: "Ingress",
  egress: "Egress",
};

/**
 * Who may reach this pod and where it may connect, from the NetworkPolicies
 * that select it: per direction, isolated or not, and what each policy lets
 * through. A refused read says so; it is never "no policy".
 */
export function PodNetworkPolicies({ pod }: { pod: PodInfo }) {
  const t = useT();
  const read = useQuery({
    queryKey: queryKeys.resources(ResourceType.NetworkPolicy, pod.namespace),
    queryFn: () => commands.listNetworkPoliciesIn([pod.namespace]),
    staleTime: STALE_TIMES.resourceList,
  });
  const known = knownOf(read);
  const policies = podPolicies(
    pod,
    known.known
      ? {
          known: true,
          value: {
            rows: known.value.rows,
            unreadHere:
              known.value.unread.find(
                (entry) => entry.namespace === pod.namespace
              )?.message ?? null,
          },
        }
      : known
  );

  if (read.isPending) {
    return (
      <p className="text-xs text-fg-fnt">
        {t("readings", "podPoliciesReading")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {(["ingress", "egress"] as const).map((which) => (
        <DirectionBlock
          key={which}
          which={which}
          state={policies[which]}
          home={pod.namespace}
          t={t}
        />
      ))}
      {policies.undecided.length > 0 && (
        <p className="text-[11.5px] text-warn">
          {t("readings", "podPoliciesUndecided", {
            names: policies.undecided.map((policy) => policy.name).join(", "),
          })}
        </p>
      )}
    </div>
  );
}

function DirectionBlock({
  which,
  state,
  home,
  t,
}: {
  which: Direction;
  state: PodDirection;
  home: string;
  t: T;
}) {
  const look = LOOK[state.state];
  const Icon = look.icon;
  return (
    <Section>
      <SectionHeader
        title={NAME[which]}
        count={
          <span className={cn("inline-flex items-center gap-1", look.tone)}>
            <Icon aria-hidden className="size-3" />
            {t("readings", WORD[which][state.state])}
          </span>
        }
        description={
          state.state === "cannotSay" && state.why
            ? state.why
            : state.state === "open"
              ? t("readings", "podPoliciesOpenWhy", { direction: NAME[which] })
              : undefined
        }
      />
      {state.state === "isolated" &&
        state.by.map((policy) => {
          const direction = policy[which];
          return (
            <div
              key={policy.name}
              className="flex flex-col gap-1.5 border-b border-hair py-2 last:border-b-0"
            >
              <ResourceRef
                kind={ResourceType.NetworkPolicy}
                name={policy.name}
                namespace={policy.namespace}
              />
              {direction.rules.length === 0 ? (
                <p className="text-[12px] text-fg-mid">
                  {t("readings", "podPoliciesDeniesAll", {
                    direction: NAME[which],
                  })}
                </p>
              ) : (
                direction.rules.map((rule, i) => (
                  <div key={i} className="flex flex-col gap-0.5 text-[12px]">
                    {rule.peers.length === 0 ? (
                      <span className="text-warn">
                        {t(
                          "empty",
                          which === "egress" ? "toAnywhere" : "fromAnywhere"
                        )}
                      </span>
                    ) : (
                      <ResolvedPeers peers={rule.peers} home={home} />
                    )}
                    <span className="text-[11px] text-fg-fnt">
                      {rule.ports.length === 0
                        ? t("empty", "everyPort")
                        : rule.ports
                            .map((port) => portText(port, t))
                            .join(", ")}
                    </span>
                  </div>
                ))
              )}
            </div>
          );
        })}
    </Section>
  );
}
