/**
 * The three places an object says where it came from, and one that says what
 * that means for you.
 *
 * The judgement about *when* each of these appears is in `@/lib/delivery` and
 * not here — this file draws whatever that decided, so the rule cannot drift
 * between the header, the Overview, the list and the dialogs. See that module
 * for why a "managed" badge on every row would have been worse than nothing.
 *
 * Nothing here names Argo CD or Flux. The vendor supplies its own name, its own
 * sentence and an opaque id that resolves to its glyph; a third delivery
 * controller would appear on all four surfaces without this file changing.
 */

import { Link } from "react-router-dom";
import { ExternalLink } from "lucide-react";

import { gitRevisionLink, shortRevision, vendorIcon } from "@/integrations";
import type { Delivery } from "@/integrations";
import {
  deliveryCell,
  deliveryLine,
  deliveryMarks,
  type DeliveryLine,
} from "@/lib/delivery";
import { openExternal } from "@/lib/open-external";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/useT";

/**
 * Where this comes from, beside the status: quiet, and always when there is
 * an answer.
 *
 * Plain small text in a role colour rather than a chip — the discipline the
 * spot mark and `cordoned` already follow — because a bordered badge here
 * would out-shout the health beside it, and provenance is never the more
 * urgent of the two.
 */
export function DeliveryMarks({ deliveries }: { deliveries: Delivery[] }) {
  const marks = deliveryMarks(deliveries);
  if (marks.length === 0) return null;

  return (
    <>
      {marks.map((mark) => {
        const Glyph = vendorIcon(mark.vendorId);
        const body = (
          <>
            {Glyph && <Glyph className="h-3 w-3 shrink-0" aria-hidden="true" />}
            <span className="font-mono">{mark.text}</span>
          </>
        );
        const className = cn(
          "inline-flex items-center gap-1.5 text-[11px]",
          mark.tone === "warn" ? "text-warn" : "text-fg-fnt"
        );
        return mark.to ? (
          <Link
            key={`${mark.vendorId}-${mark.text}`}
            to={mark.to}
            className={cn(className, "hover:text-fg-mut")}
          >
            {body}
          </Link>
        ) : (
          <span key={`${mark.vendorId}-${mark.text}`} className={className}>
            {body}
          </span>
        );
      })}
    </>
  );
}

/**
 * The earned line, above everything, or nothing at all.
 *
 * A managed object that is in sync and whose delivery will not fight you gets
 * **no line**. That is the whole discipline: on a cluster Argo runs, a line
 * that appeared for "this is managed" would be on every page in the app and
 * would be worth exactly as much as a badge on every row.
 */
export function DeliveryBanner({ deliveries }: { deliveries: Delivery[] }) {
  const t = useT();
  const line = deliveryLine(deliveries, t);
  if (!line) return null;
  return <DeliveryLineBody line={line} />;
}

function DeliveryLineBody({ line }: { line: DeliveryLine }) {
  return (
    <div
      className={cn(
        "border-l-2 pl-3",
        line.tone === "warn" ? "border-warn" : "border-info"
      )}
    >
      <p
        className={cn(
          "text-xs",
          line.tone === "warn" ? "text-warn" : "text-info"
        )}
      >
        {line.title}
      </p>
      <p className="mt-0.5 text-xs text-fg-mut">
        {line.detail}
        {line.where && <DeliveryWhere where={line.where} />}
      </p>
    </div>
  );
}

/**
 * Where the change would actually have to be made.
 *
 * The revision is a link only where the remote resolves to a real page —
 * `gitRepoLink` refuses ssh remotes, self-hosted hosts and anything carrying a
 * credential, and a link that landed on a login wall would make the reader
 * doubt the app rather than the link.
 */
function DeliveryWhere({
  where,
}: {
  where: {
    path: string | null;
    revision: string | null;
    repoUrl?: string | null;
  };
}) {
  const t = useT();
  const link = where.repoUrl
    ? gitRevisionLink(where.repoUrl, where.revision)
    : null;
  if (!where.path && !where.revision) return null;

  return (
    <>
      {" "}
      {where.path && (
        <>
          {t("empty", "manifestsAreAt")}{" "}
          <span className="font-mono">{where.path}</span>
          {where.revision ? " " : "."}
        </>
      )}
      {where.revision &&
        (link ? (
          <>
            {t("empty", "inRevision")}{" "}
            <button
              type="button"
              onClick={() => openExternal(link.url, link.site)}
              className="inline-flex items-center gap-0.5 font-mono text-info hover:underline"
            >
              {shortRevision(where.revision)}
              <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
            </button>
            .
          </>
        ) : (
          <>
            {t("empty", "inRevision")}{" "}
            <span className="font-mono">{shortRevision(where.revision)}</span>.
          </>
        ))}
    </>
  );
}

/**
 * The `Delivery` column's cell.
 *
 * Empty for the ordinary delivered-and-fine row, which on a GitOps cluster is
 * most of them: a problem earns a mark and inventory does not. `not delivered`
 * is faint and not a warning — it is worth knowing and it is not a fault.
 */
export function DeliveryCell({ deliveries }: { deliveries: Delivery[] }) {
  const t = useT();
  const cell = deliveryCell(deliveries, t);
  if (!cell) return null;
  return (
    <span
      className={cn(
        "text-[11px]",
        cell.tone === "warn" ? "text-warn" : "text-fg-fnt"
      )}
    >
      {cell.text}
    </span>
  );
}
