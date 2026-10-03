import { ProviderMark } from "@/components/ui/provider-mark";
import {
  clusterColor,
  clusterNameParts,
  detectProvider,
} from "@/lib/cluster-identity";
import { cn } from "@/lib/utils";
import { useClusterMark } from "@/stores/clusterIdentityStore";

/**
 * One cluster, wherever a cluster is offered.
 *
 * Both places that list clusters — the tab's cluster segment and the front
 * door — answer the same question, so they are one row. Only the trailing
 * fact differs (a provider label in the tab, how long ago it was used on
 * the front door), which is why that is a slot rather than a variant.
 *
 * The dot keeps the cluster's identity colour rather than becoming a status
 * light: this row's job is telling two similarly-named clusters apart, and
 * the colour is what does that on every other surface in the window. A
 * cluster that just refused the connection is the one exception.
 *
 * A renamed cluster reads as two lines: the alias, and dimmed under it the
 * context name itself. This is the list you pick a cluster from, so it is
 * the last place an alias may be the only thing on offer — you have to know
 * which context you are connecting to before you press Enter on it.
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
  const mark = useClusterMark(context);
  const alias = mark.alias?.trim();
  const color = clusterColor(context, mark.hue);

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
        {alias ? (
          <span className="flex min-w-0 flex-col">
            <span
              className={cn("truncate", selected ? "text-fg" : "text-fg-mid")}
            >
              {alias}
            </span>
            <span className="truncate font-mono text-[10px] leading-[13px] text-fg-fnt">
              {context}
            </span>
          </span>
        ) : (
          <span className="truncate font-mono">
            {prefix && <span className="text-fg-fnt">{prefix}</span>}
            <span className={selected ? "text-fg" : "text-fg-mid"}>
              {label}
            </span>
          </span>
        )}
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
