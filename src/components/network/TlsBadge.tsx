import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface TlsBadgeProps {
  tlsHosts: string[];
  hasCatchAllTls: boolean;
  /**
   * What a cloud controller says, for the hosts `spec.tls` is silent about.
   *
   * All three managed clouds keep the certificate off the Ingress — an ACM
   * ARN, a `ManagedCertificate`, one installed on an Application Gateway — so
   * without this the column read "no TLS" on every HTTPS site on a managed
   * cluster.
   */
  vendor?: { hosts: string[]; by: string } | null;
}

/**
 * Whether an ingress terminates TLS.
 *
 * A certificate being present is configuration, not a lifecycle state, so it
 * reads as text: a green pill on every TLS row claimed something had gone
 * right, and left "No TLS" looking like a failure rather than a choice.
 */
export function TlsBadge({ tlsHosts, hasCatchAllTls, vendor }: TlsBadgeProps) {
  const explicitCount = tlsHosts.length;
  const vendorHosts = vendor?.hosts ?? [];

  if (explicitCount === 0 && !hasCatchAllTls && vendorHosts.length === 0) {
    return <span className="text-fg-fnt">no TLS</span>;
  }

  // The controller's answer is not a Secret in this cluster, so it is counted
  // apart from the ones that are and named in the tooltip.
  if (explicitCount === 0 && !hasCatchAllTls) {
    return (
      <Tooltip>
        <TooltipTrigger className="text-fg-mid">
          TLS {vendorHosts.length}
        </TooltipTrigger>
        <TooltipContent>
          <div className="text-xs">from {vendor?.by}</div>
          {vendorHosts.map((host) => (
            <div key={host} className="text-xs">
              {host}
            </div>
          ))}
        </TooltipContent>
      </Tooltip>
    );
  }

  const label =
    explicitCount > 0
      ? hasCatchAllTls
        ? `TLS ${explicitCount} + all`
        : `TLS ${explicitCount}`
      : "TLS all";

  const hosts = [
    ...(hasCatchAllTls ? [...tlsHosts, "+ catch-all certificate"] : tlsHosts),
    ...vendorHosts.map((host) => `${host} — from ${vendor?.by}`),
  ];

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
