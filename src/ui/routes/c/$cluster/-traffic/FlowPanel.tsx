/**
 * One pair, opened from its edge: every source's own numbers, each said as
 * what that source counted, and which of them the line and the table show.
 */
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/useT";
import type { FlowRow } from "@/lib/traffic";
import { Link } from "@tanstack/react-router";

import type { PolicyRef } from "@/generated/types";
import { useCrdIndex } from "@/hooks/useCrdIndex";
import { parts } from "@/i18n/parts";
import { crdInGroup, objectLink } from "@/lib/links";
import {
  endLabel,
  endSub,
  policyWords,
  rate,
  sourceLines,
} from "./traffic-words";

/** Each policy that denied a drop, opening the policy where the app can. */
function Policies({ policies }: { policies: readonly PolicyRef[] }) {
  const { crdFor } = useCrdIndex();
  return policies.map((policy, at) => {
    const link = objectLink({
      kind: policy.kind,
      name: policy.name,
      namespace: policy.namespace,
      crd: crdInGroup(policy, crdFor) ?? undefined,
    });
    const words = policyWords([policy]);
    return (
      <span key={words}>
        {at > 0 && ", "}
        {link ? (
          <Link {...link} className="font-mono text-info hover:underline">
            {words}
          </Link>
        ) : (
          <span className="font-mono">{words}</span>
        )}
      </span>
    );
  });
}

export function FlowPanel({
  row,
  window,
  onClose,
}: {
  row: FlowRow;
  window: string;
  onClose: () => void;
}) {
  const t = useT();
  const shown =
    row.requests.source ?? row.bytes.source ?? row.events.source ?? null;
  return (
    <aside
      className="absolute right-2 top-2 z-10 flex max-h-[calc(100%-16px)] w-80 flex-col gap-2 overflow-y-auto scrollbar-lane rounded-lg border border-hair bg-raise p-3 text-[12px] shadow-lg"
      aria-label={t("traffic", "panelLabel")}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-fg">
            {endLabel(row.from)} → {endLabel(row.to)}
          </p>
          <p className="truncate text-[11px] text-fg-fnt">
            {endSub(row.from, t)} → {endSub(row.to, t)} · {window}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label={t("traffic", "panelClose")}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
      {row.by.length > 1 && shown && (
        <p className="text-fg-mut">
          {t("traffic", "panelSeenBy", {
            sources: row.seenBy.join(", "),
            source: shown,
          })}
        </p>
      )}
      {row.by.map((line) => {
        const lines = sourceLines(line, t);
        return (
          <section key={line.source.id} className="flex flex-col gap-0.5">
            <p className="font-medium text-fg">
              {t("traffic", "panelCounted", { source: line.source.name })}
            </p>
            {lines.length > 0 ? (
              lines.map((text) => (
                <p key={text} className="font-mono text-[11.5px] text-fg-mut">
                  {text}
                </p>
              ))
            ) : (
              <p className="text-fg-fnt">{t("traffic", "panelNothing")}</p>
            )}
            {line.reasons.map((reason) => (
              <p
                key={`${reason.reason}:${reason.l7 ? "l7" : ""}:${policyWords(reason.policies ?? [])}`}
                className="text-[11.5px] text-warn"
              >
                <span className="font-mono">
                  {reason.l7
                    ? t("traffic", "panelL7Denied", { v: rate(reason.rate) })
                    : `${reason.reason}: ${rate(reason.rate)}/s`}
                </span>
                {(reason.policies ?? []).length > 0 && (
                  <>
                    {" · "}
                    {parts(t("traffic", "panelDenied"), {
                      policies: <Policies policies={reason.policies ?? []} />,
                    })}
                  </>
                )}
              </p>
            ))}
          </section>
        );
      })}
      {(row.p50.value ?? row.p95.value ?? row.p99.value) !== null && (
        <p className="text-[11px] text-fg-fnt">
          {t("traffic", "panelBuckets", {
            source: row.p50.source ?? row.p95.source ?? row.p99.source ?? "",
          })}
        </p>
      )}
    </aside>
  );
}
