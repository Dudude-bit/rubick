import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

import { formatAge } from "@/lib/utils";
import { useAlertArrivalStore } from "@/stores/alertArrivalStore";
import { useT } from "@/i18n/useT";
import { useClusterStore } from "@/stores/clusterStore";

/**
 * What the alert said, on the page of the object it named.
 *
 * The alert's sentence stays the alert's sentence: quoted, dated, and beside
 * what this app read itself rather than in place of it. A pod that recovered
 * eleven minutes after the rule fired is the ordinary case, and an app that
 * redrew those words as the pod's state would send somebody hunting a crash
 * loop that had already ended.
 *
 * `now` is whatever this page has already read of the object. `undefined`
 * means the read has not come back, which is not the same as the object being
 * fine, and a refusal is neither.
 */
export function AlertBanner({
  kind,
  name,
  namespace,
  now,
  readAt,
  error,
  reading: stillReading,
}: {
  kind: string;
  name: string;
  namespace: string | null;
  now?: ReactNode;
  /** When the page last heard from the cluster. */
  readAt?: number;
  error?: string;
  /** The page has not finished its own read yet. */
  reading?: boolean;
}) {
  const t = useT();
  const context = useClusterStore((s) => s.currentContext);
  const reading = useAlertArrivalStore((s) => s.reading);
  const at = useAlertArrivalStore((s) => s.at);
  const dismiss = useAlertArrivalStore((s) => s.dismiss);

  if (!reading || !at) return null;
  // The cluster too: the alert named an object in one, and its words were
  // drawn on the object of the same name in whichever cluster the window
  // happened to be showing.
  if (at.context !== null && at.context !== context) return null;
  if (at.kind !== kind || at.name !== name) return null;
  // A page that has no namespace of its own — a Node, a Namespace, anything
  // cluster-scoped — cannot match the label the alert carried, and the
  // banner simply never appeared on exactly those pages.
  if (namespace !== null && at.namespace !== null && at.namespace !== namespace)
    return null;

  const when = reading.firedAt;

  return (
    <div className="rounded border border-warn/40 bg-warn/[0.07] px-3 py-2">
      <div className="flex items-baseline gap-2 text-[11.5px] text-warn">
        <AlertTriangle
          aria-hidden="true"
          className="h-3.5 w-3.5 flex-none translate-y-0.5"
        />
        <span className="font-mono">{reading.alertName}</span>
        {when ? (
          <span>
            {t("alerts", "saidAt", {
              name: "",
              when: new Date(when.value).toLocaleTimeString(),
              ago: formatAge(new Date(when.value).toISOString(), t),
            }).trim()}
          </span>
        ) : null}
        <button
          type="button"
          onClick={dismiss}
          className="ml-auto flex-none text-[11px] text-fg-fnt hover:text-fg-mut"
        >
          {t("alerts", "dismiss")}
        </button>
      </div>
      {reading.claim ? (
        <p className="mt-1.5 border-l-2 border-warn/40 pl-2.5 text-[11.5px] text-fg-mid">
          {reading.claim}
        </p>
      ) : null}
      <p className="mt-1 text-[10.5px] text-fg-fnt">
        {t("alerts", "theAlertsWords")}
      </p>
      <p className="mt-2 border-t border-hair pt-2 text-[11.5px] text-fg-mut">
        <span className="text-fg-fnt">{t("alerts", "readJustNow")}</span>{" "}
        {error !== undefined ? (
          <span className="text-err">
            {t("alerts", "couldNotRead", { error })}
          </span>
        ) : stillReading ? (
          <span className="text-fg-fnt">{t("alerts", "stillReading")}</span>
        ) : now === undefined || now === null || now === false ? (
          // Ten of the detail pages have no status badge at all — a
          // ConfigMap has no state to show — and saying "still reading"
          // there was a claim about the app, not about the object, that
          // never went away.
          <span className="text-fg-fnt">
            {readAt !== undefined
              ? t("alerts", "readAgo", {
                  ago: formatAge(new Date(readAt).toISOString(), t),
                })
              : t("alerts", "readNoStatus")}
          </span>
        ) : (
          <span className="inline-flex items-baseline gap-2">
            {now}
            {readAt !== undefined ? (
              <span className="text-[10.5px] text-fg-fnt">
                {t("alerts", "readAgo", {
                  ago: formatAge(new Date(readAt).toISOString(), t),
                })}
              </span>
            ) : null}
          </span>
        )}
      </p>
    </div>
  );
}
