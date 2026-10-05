/**
 * Cilium: which pods a policy actually reaches.
 *
 * The CRD views answer "what does this policy say". This page answers the
 * question a person actually has — **is this pod covered, and by what** —
 * which needs the two sides joined: a policy names labels, and a
 * `CiliumEndpoint` carries the labels Cilium itself resolved for the pod.
 * Neither list can say it alone.
 *
 * The row is the endpoint rather than the policy, because the dangerous
 * answer is about a pod and not about a rule: a pod nothing selects is
 * unrestricted, and a pod selected *only* by policies the operator threw
 * away looks covered from every other screen in this app. The policies are
 * under it, with the rejected ones marked.
 */

import { useMemo } from "react";
import {
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  ShieldQuestionMark,
  ShieldX,
  type LucideIcon,
} from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { ResourceRef } from "@/components/object/ResourceRef";
import { useT } from "@/i18n/useT";
import { TONE_TEXT } from "@/lib/tone";
import { cn } from "@/lib/utils";
import { ShareScreenAction } from "@/components/share/ShareAction";
import { useShareSection } from "@/components/share/screen-share";
import { iconSvg } from "@/lib/icon-svg";
import { ORDER, refOf } from "@/lib/report-parts";
import type { StatusRole } from "@/lib/status-role";
import {
  Finding,
  TroubleList,
  TroubleRow,
  VendorReadFailure,
} from "../page-kit";
import type { RowTone } from "../page-kit";
import {
  DIRECTIONS,
  type Coverage,
  type Direction,
  type DirectionState,
  type Selecting,
} from "./coverage";
import { KINDS, pictureCoverage, usePicture } from "./data";
import { enforcementOf } from "./model";

const VERDICT_TONE: Record<Coverage["verdict"], RowTone> = {
  covered: "ok",
  // Not red: a pod nobody wrote a policy for is a choice, and most clusters
  // have made it for most of their pods. Red here would paint a default
  // cluster in failures and hide the row below, which is the real one.
  unrestricted: "warn",
  onlyRejected: "err",
  // Not warn: that is "nothing selects it", and this is "could not tell".
  cannotSay: "unknown",
};

const VERDICT_WORD: Record<
  Coverage["verdict"],
  | "ciliumCovered"
  | "ciliumUnrestricted"
  | "ciliumOnlyRejected"
  | "ciliumCannotSay"
> = {
  covered: "ciliumCovered",
  unrestricted: "ciliumUnrestricted",
  onlyRejected: "ciliumOnlyRejected",
  cannotSay: "ciliumCannotSay",
};

// "cannotSay" is a third state, not a colour: StatusRole has no "unknown",
// so it lands on "neutral" rather than borrowing warn or err.
const FINDING_ROLE: Record<Coverage["verdict"], StatusRole | null> = {
  covered: null,
  unrestricted: "warn",
  onlyRejected: "err",
  cannotSay: "neutral",
};

export default function CiliumPage() {
  const t = useT();
  const picture = usePicture();

  const coverage = useMemo(
    () => (picture.data ? pictureCoverage(picture.data) : []),
    [picture.data]
  );
  const kubernetes = picture.data?.kubernetes;

  const onlyRejected = coverage.filter((one) => one.verdict === "onlyRejected");
  const unrestricted = coverage.filter((one) => one.verdict === "unrestricted");
  const rejected = [
    ...(picture.data?.policies ?? []),
    ...(picture.data?.clusterwide ?? []),
  ].filter((policy) => enforcementOf(policy).state === "rejected");

  useShareSection("cilium-rejected-policies", () => {
    if (rejected.length === 0) return null;
    return {
      id: "cilium-rejected-policies",
      order: ORDER.own,
      title: "Rejected policies",
      icon: iconSvg(ShieldAlert),
      count: rejected.length,
      body: {
        type: "findings",
        items: rejected.map((policy) => {
          const enforcement = enforcementOf(policy);
          return {
            title: policy.name,
            detail: enforcement.state === "rejected" ? enforcement.why : null,
            role: "err" as const,
            ref: refOf({
              kind: policy.kind,
              name: policy.name,
              namespace: policy.namespace,
            }),
          };
        }),
      },
    };
  });

  if (picture.error) {
    return (
      <VendorReadFailure
        title={t("empty", "couldNotReadCilium")}
        body={t("empty", "couldNotReadCiliumBody")}
        error={picture.error}
        onRetry={() => void picture.refetch()}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Section>
        <SectionHeader
          title="Cilium"
          description={t("empty", "ciliumPageDescription")}
          actions={<ShareScreenAction screen={{ title: "Cilium" }} />}
        />
        <div className="flex flex-col gap-2">
          {kubernetes && !kubernetes.read && (
            <Finding
              tone="warn"
              title={t("readings", "ciliumFindingKubernetesUnread")}
              verbatim={kubernetes.why}
            />
          )}
          {rejected.length > 0 && (
            <Finding
              tone="err"
              title={t("readings", "ciliumFindingRejected", {
                n: rejected.length,
              })}
            >
              {rejected.map((policy) => policy.name).join(", ")}
            </Finding>
          )}
          {onlyRejected.length > 0 && (
            <Finding
              tone="err"
              title={t("readings", "ciliumFindingOnlyRejected", {
                n: onlyRejected.length,
              })}
            />
          )}
          {unrestricted.length > 0 && (
            <Finding
              tone="warn"
              title={t("readings", "ciliumFindingUnrestricted", {
                n: unrestricted.length,
              })}
            />
          )}
        </div>
      </Section>

      <Section>
        {picture.isPending ? (
          <p className="text-xs text-fg-fnt">{t("empty", "readingCilium")}</p>
        ) : coverage.length === 0 ? (
          <p className="max-w-[64ch] text-xs text-fg-mut">
            {t("empty", "ciliumNoEndpoints")}
          </p>
        ) : (
          <TroubleList
            items={coverage}
            severityOf={severityOfCoverage}
            searchable={searchableCoverage}
            filter={{
              placeholder: t("action", "searchEllipsis"),
              label: t("action", "searchEllipsis"),
            }}
            // The findings above say what is wrong; no row opens itself.
            autoOpen={{ when: "err", upTo: 0 }}
            noMatch={(query) => t("empty", "nothingMatchesQuery", { query })}
            keyOf={(one) =>
              one.endpoint.uid ||
              `${one.endpoint.namespace}/${one.endpoint.name}`
            }
            renderRow={(one, { last }) => <CoverageRow one={one} last={last} />}
            share={{
              title: "Endpoints",
              toFinding: (one) => {
                const role = FINDING_ROLE[one.verdict];
                if (!role) return null;
                return {
                  title: one.endpoint.name,
                  detail: t("readings", VERDICT_WORD[one.verdict]),
                  role,
                  ref: refOf({
                    kind: "CiliumEndpoint",
                    name: one.endpoint.name,
                    namespace: one.endpoint.namespace,
                  }),
                };
              },
            }}
          />
        )}
      </Section>
    </div>
  );
}

/** One endpoint, and what each direction is under. */
function CoverageRow({ one, last }: { one: Coverage; last: boolean }) {
  const t = useT();
  return (
    <TroubleRow
      key={one.endpoint.uid || `${one.endpoint.namespace}/${one.endpoint.name}`}
      title={one.endpoint.name}
      reference={{
        kind: "CiliumEndpoint",
        name: one.endpoint.name,
        namespace: one.endpoint.namespace,
        crd: KINDS.endpoints,
      }}
      meta={one.endpoint.namespace}
      state={{
        text: t("readings", VERDICT_WORD[one.verdict]),
        tone: VERDICT_TONE[one.verdict],
      }}
      last={last}
    >
      <div className="flex flex-col gap-1.5">
        {DIRECTIONS.map((direction) => (
          <DirectionLine key={direction} one={one} direction={direction} />
        ))}
      </div>
      {one.unreadable > 0 && (
        <p className="text-[11.5px] text-warn">
          {t("readings", "ciliumUnreadablePolicies", {
            n: one.unreadable,
          })}
        </p>
      )}
    </TroubleRow>
  );
}

const DIRECTION_LOOK: Record<
  DirectionState,
  { icon: LucideIcon; tone: RowTone }
> = {
  restricted: { icon: ShieldCheck, tone: "ok" },
  onlyRejected: { icon: ShieldX, tone: "err" },
  unrestricted: { icon: ShieldOff, tone: "warn" },
  cannotSay: { icon: ShieldQuestionMark, tone: "unknown" },
};

const DIRECTION_WORD: Record<
  DirectionState,
  | "ciliumDirectionRestricted"
  | "ciliumDirectionOnlyRejected"
  | "ciliumDirectionOpen"
  | "ciliumDirectionCannotSay"
> = {
  restricted: "ciliumDirectionRestricted",
  onlyRejected: "ciliumDirectionOnlyRejected",
  unrestricted: "ciliumDirectionOpen",
  cannotSay: "ciliumDirectionCannotSay",
};

/** `policyTypes` spells the two directions, and so does this line. */
const DIRECTION_NAME: Record<Direction, string> = {
  ingress: "Ingress",
  egress: "Egress",
};

function DirectionLine({
  one,
  direction,
}: {
  one: Coverage;
  direction: Direction;
}) {
  const t = useT();
  const state = one.directions[direction];
  const look = DIRECTION_LOOK[state];
  const Icon = look.icon;
  const governing = one.selecting.filter(
    (selecting) => selecting.restricts[direction]
  );
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11.5px]">
      <Icon
        aria-hidden
        className={cn("size-3 flex-none self-center", TONE_TEXT[look.tone])}
      />
      <span className="w-12 flex-none font-mono text-fg-mid">
        {DIRECTION_NAME[direction]}
      </span>
      <span className={TONE_TEXT[look.tone]}>
        {t("readings", DIRECTION_WORD[state])}
      </span>
      {governing.map((selecting) => (
        <PolicyRef key={refKey(selecting)} selecting={selecting} />
      ))}
      {state === "cannotSay" && one.kubernetesUnread && (
        <span className="text-fg-fnt" title={one.kubernetesUnread}>
          {t("readings", "ciliumNetworkPoliciesUnread")}
        </span>
      )}
    </div>
  );
}

const refKey = (selecting: Selecting) =>
  `${selecting.kind}/${selecting.namespace ?? "*"}/${selecting.name}`;

function PolicyRef({ selecting }: { selecting: Selecting }) {
  const t = useT();
  return (
    <span className="inline-flex items-baseline gap-1">
      <ResourceRef
        kind={selecting.kind}
        name={selecting.name}
        namespace={selecting.namespace}
        crd={
          selecting.kind === "NetworkPolicy"
            ? undefined
            : selecting.clusterwide
              ? KINDS.clusterwide
              : KINDS.policies
        }
      />
      {!selecting.enforcing && (
        <span className="text-[10.5px] text-err">
          {t("readings", "ciliumEnforcesNothing")}
        </span>
      )}
    </span>
  );
}

const severityOfCoverage = (one: Coverage) => {
  const tone = VERDICT_TONE[one.verdict];
  return tone === "ok" ? null : tone;
};

const searchableCoverage = (one: Coverage) => [
  one.endpoint.name,
  one.endpoint.namespace,
  ...one.selecting.map((selecting) => selecting.name),
];
