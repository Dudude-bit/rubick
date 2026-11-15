/**
 * What the cluster costs, and who spends it: from OpenCost's series in the
 * connected Prometheus, or estimated from prices the reader entered. Every
 * number here is one the namespace and workload pages read too.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Coins } from "lucide-react";

import { PricesDialog } from "@/components/cost/PricesDialog";
import { ShareScreenAction } from "@/components/share/ShareAction";
import { useShareSection } from "@/components/share/screen-share";
import { Button } from "@/components/ui/button";
import { ConnectClusterEmptyState } from "@/components/ui/connect-cluster-empty-state";
import { Section, SectionBody, SectionHeader } from "@/components/ui/section";
import type { T } from "@/i18n/useT";
import { useT } from "@/i18n/useT";
import {
  currencyOf,
  formatMoney,
  formatShare,
  monthOf,
  type CostPicture,
} from "@/lib/cost";
import { iconSvg } from "@/lib/icon-svg";
import { ORDER, type PlacedSection } from "@/lib/report-parts";
import { useCost, useWorkloadUsage, type CostState } from "@/hooks/useCost";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { useClusterStore } from "@/stores/clusterStore";
import { useCostPrices } from "@/stores/costPricesStore";
import { BasisFailed, CostNotes, NothingYet, SupplierOnly } from "./cost-notes";
import { CostTables } from "./cost-tables";
import { amountWords, sourceWords } from "./cost-words";
import { CostTrend } from "./cost-trend";

function summarySection(
  picture: CostPicture,
  scoped: boolean,
  context: string,
  t: T
): PlacedSection {
  const currency = currencyOf(picture);
  const rows: { label: string; values: { text: string; mono?: boolean }[] }[] =
    [];
  const add = (label: string, text: string) =>
    rows.push({ label, values: [{ text, mono: true }] });
  if (picture.total) {
    add(t("cost", "perHour"), amountWords(picture.total, currency, t));
    add(
      t("cost", "perMonth"),
      amountWords(
        {
          perHour: monthOf(picture.total.perHour),
          atLeast: picture.total.atLeast,
        },
        currency,
        t
      )
    );
  }
  if (scoped && picture.cluster)
    add(t("cost", "theCluster"), amountWords(picture.cluster, currency, t));
  add(
    t("cost", "idle"),
    picture.idle
      ? amountWords(picture.idle, currency, t)
      : t("cost", idleUnknown(picture) ? "idleUnpriced" : "notKnown")
  );
  if (picture.unclaimed !== null)
    add(t("cost", "unclaimed"), formatMoney(picture.unclaimed, currency));
  if (picture.fee !== null)
    add(t("cost", "fee"), formatMoney(picture.fee, currency));
  return {
    id: "cost-summary",
    title: t("cost", "title"),
    icon: iconSvg(Coins),
    order: ORDER.summary,
    caption: `${sourceWords(picture, context, t)} ${t("cost", "monthNote")}`,
    body: { type: "facts", rows },
  };
}

function Tile({
  label,
  value,
  note,
  testId,
}: {
  label: string;
  value: string;
  note?: string;
  testId?: string;
}) {
  return (
    <div className="flex min-w-[150px] flex-1 flex-col gap-0.5 rounded-md border border-hair px-3 py-2">
      <span className="text-[11px] text-fg-mut">{label}</span>
      <span
        className="font-mono text-base tabular-nums text-fg"
        data-testid={testId}
      >
        {value}
      </span>
      {note && <span className="text-[11px] text-fg-fnt">{note}</span>}
    </div>
  );
}

/** Nodes were read and none of them carries a price: idle has nothing to be taken from. */
const idleUnknown = (picture: CostPicture) =>
  picture.nodes !== null &&
  picture.nodes.length > 0 &&
  picture.nodes.every((node) => node.perHour === null);

function Tiles({ picture, scoped }: { picture: CostPicture; scoped: boolean }) {
  const t = useT();
  const currency = currencyOf(picture);
  const total = picture.total;
  const idle = picture.idle;
  const whole = picture.cluster?.perHour ?? null;
  return (
    <div className="flex flex-wrap gap-2">
      <Tile
        label={t("cost", "perHour")}
        value={total ? amountWords(total, currency, t) : t("cost", "notKnown")}
        testId="cost-per-hour"
        note={
          scoped && total && whole !== null && whole > 0
            ? t("cost", "ofCluster", {
                share: formatShare(total.perHour / whole),
              })
            : undefined
        }
      />
      <Tile
        label={t("cost", "perMonth")}
        value={
          total
            ? amountWords(
                { perHour: monthOf(total.perHour), atLeast: total.atLeast },
                currency,
                t
              )
            : t("cost", "notKnown")
        }
        note={t("cost", "monthNote")}
      />
      <Tile
        label={t("cost", scoped ? "idleCluster" : "idle")}
        value={idle ? amountWords(idle, currency, t) : t("cost", "notKnown")}
        testId="cost-idle"
        note={
          !idle && idleUnknown(picture)
            ? t("cost", "idleUnpriced")
            : idle && idle.reserved !== null && idle.reserved > 0
              ? t("cost", "reservedNote", {
                  amount: formatMoney(idle.reserved, currency),
                })
              : t("cost", "idleNote")
        }
      />
      {!scoped && picture.unclaimed !== null && picture.unclaimed > 0 && (
        <Tile
          label={t("cost", "unclaimed")}
          value={formatMoney(picture.unclaimed, currency)}
        />
      )}
      {!scoped && picture.fee !== null && (
        <Tile
          label={t("cost", "fee")}
          value={formatMoney(picture.fee, currency)}
        />
      )}
    </div>
  );
}

function PictureView({
  cost,
  namespaces,
  retry,
}: {
  cost: Extract<CostState, { state: "picture" }>;
  namespaces: string[] | null;
  retry: () => void;
}) {
  const t = useT();
  const { picture, trouble } = cost;
  const scoped = namespaces !== null;
  const keys = useMemo(
    () => picture.workloads.map((w) => w.key),
    [picture.workloads]
  );
  const usage = useWorkloadUsage(namespaces, keys);
  const context = useClusterStore((s) => s.currentContext) ?? "";
  useShareSection("cost-summary", () => [
    summarySection(picture, scoped, context, t),
  ]);
  return (
    <div className="flex flex-col gap-3">
      <CostNotes picture={picture} trouble={trouble} onRetry={retry} />
      <Tiles picture={picture} scoped={scoped} />
      <CostTrend picture={picture} namespaces={namespaces} />
      <CostTables picture={picture} usage={usage} />
    </div>
  );
}

export function CostPage() {
  const t = useT();
  const isConnected = useClusterStore((s) => s.isConnected);
  const context = useClusterStore((s) => s.currentContext);
  const scope = useNamespaceScope();
  const namespaces = useMemo(
    () => (scope.isAll ? null : [...scope.scope]),
    [scope.isAll, scope.scope]
  );
  const { cost, retry } = useCost(namespaces);
  const prices = useCostPrices(context);
  const [editing, setEditing] = useState(false);

  if (!isConnected || !context)
    return <ConnectClusterEmptyState resourceLabel={t("nav", "cost")} />;

  const picture = cost.state === "picture" ? cost.picture : null;
  return (
    <div className="flex flex-col gap-2">
      <SectionHeader
        title={t("cost", "title")}
        count={scope.label}
        description={picture ? sourceWords(picture, context, t) : undefined}
        actions={
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing(true)}
            >
              {t("cost", prices ? "pricesEdit" : "pricesEnter")}
            </Button>
            <ShareScreenAction
              screen={{ title: t("cost", "title"), scope: scope.scope }}
            />
          </>
        }
      />
      {cost.state === "picture" ? (
        <PictureView cost={cost} namespaces={namespaces} retry={retry} />
      ) : (
        <Section>
          <SectionBody>
            <Waiting
              cost={cost}
              onPrices={() => setEditing(true)}
              retry={retry}
            />
          </SectionBody>
        </Section>
      )}
      <PricesDialog
        context={context}
        open={editing}
        onOpenChange={setEditing}
        supplierAnswers={picture?.source.kind === "opencost"}
      />
    </div>
  );
}

const WAITING: Record<
  Exclude<CostState["state"], "picture">,
  (props: {
    cost: Exclude<CostState, { state: "picture" }>;
    onPrices: () => void;
    retry: () => void;
  }) => ReactNode
> = {
  loading: () => <Reading />,
  nothing: ({ onPrices }) => <NothingYet onPrices={onPrices} />,
  supplier: ({ cost, onPrices }) =>
    cost.state === "supplier" && (
      <SupplierOnly trouble={cost.trouble} onPrices={onPrices} />
    ),
  basisFailed: ({ cost, retry }) =>
    cost.state === "basisFailed" && (
      <BasisFailed error={cost.error} onRetry={retry} />
    ),
};

function Reading() {
  const t = useT();
  return (
    <p className="px-1 py-4 text-xs text-fg-mut" role="status">
      {t("action", "reading")}
    </p>
  );
}

function Waiting(props: {
  cost: Exclude<CostState, { state: "picture" }>;
  onPrices: () => void;
  retry: () => void;
}) {
  return <>{WAITING[props.cost.state](props)}</>;
}
