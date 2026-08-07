import { ProviderMark } from "@/components/ui/provider-mark";
import {
  clusterColor,
  clusterNameParts,
  detectProvider,
} from "@/lib/cluster-identity";
import { cn } from "@/lib/utils";

/**
 * One cluster, wherever a cluster is offered.
 *
 * The app has two places that put clusters in a list — the tab's cluster
 * segment and the front door — and they answer the same question, so they
 * are the same row: identity dot, provider mark, name with its provider
 * boilerplate dimmed, and one trailing fact. Only that trailing fact
 * differs (a provider label in the tab, how long ago it was used on the
 * front door), which is why it is a slot rather than a variant.
 *
 * The dot keeps the cluster's identity colour rather than becoming a
 * status light: this row's whole job is telling two similarly-named
 * clusters apart, and the colour is the thing that does it on every other
 * surface in the window. A cluster that just refused the connection is
 * the one exception, because a red dot is the fact worth reading first.
 */
export function ClusterRow({
  context,
  meta,
  failed,
  selected,
  className,
}: {
  context: string;
  /** The one trailing fact this list is worth reading for. */
  meta?: React.ReactNode;
  /** The last connection to this cluster came back with an error. */
  failed?: boolean;
  selected?: boolean;
  className?: string;
}) {
  const { prefix, label } = clusterNameParts(context);
  const color = clusterColor(context);

  return (
    <span
      className={cn(
        "grid w-full grid-cols-[6px_1fr_auto] items-center gap-[9px] rounded-[5px] px-[7px] py-[5px] text-left text-xs",
        className
      )}
    >
      <span
        className={cn("h-1.5 w-1.5 rounded-full", failed && "bg-err")}
        style={failed ? undefined : { background: color }}
      />
      <span className="flex items-center gap-[7px] overflow-hidden">
        <ProviderMark
          provider={detectProvider(context)}
          style={{ color }}
          className="flex-none"
        />
        <span className="truncate font-mono">
          {prefix && <span className="text-fg-fnt">{prefix}</span>}
          <span className={selected ? "text-fg" : "text-fg-mid"}>{label}</span>
        </span>
      </span>
      {meta != null && (
        <span
          className={cn(
            "whitespace-nowrap text-[11px]",
            failed ? "text-err" : "text-fg-fnt"
          )}
        >
          {meta}
        </span>
      )}
    </span>
  );
}
