import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface TlsBadgeProps {
  tlsHosts: string[];
  hasCatchAllTls: boolean;
}

/**
 * Whether an ingress terminates TLS.
 *
 * A certificate being present is configuration, not a lifecycle state, so it
 * reads as text: a green pill on every TLS row claimed something had gone
 * right, and left "No TLS" looking like a failure rather than a choice.
 */
export function TlsBadge({ tlsHosts, hasCatchAllTls }: TlsBadgeProps) {
  const explicitCount = tlsHosts.length;

  if (explicitCount === 0 && !hasCatchAllTls) {
    return <span className="text-fg-fnt">no TLS</span>;
  }

  const label =
    explicitCount > 0
      ? hasCatchAllTls
        ? `TLS ${explicitCount} + all`
        : `TLS ${explicitCount}`
      : "TLS all";

  const hosts = hasCatchAllTls
    ? [...tlsHosts, "+ catch-all certificate"]
    : tlsHosts;

  return (
    <Tooltip>
      <TooltipTrigger className="text-fg-mid">{label}</TooltipTrigger>
      <TooltipContent>
        {hosts.map((host) => (
          <div key={host} className="text-xs">
            {host}
          </div>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}
