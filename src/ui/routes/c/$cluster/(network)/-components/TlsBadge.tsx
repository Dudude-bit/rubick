import { useT } from "@/i18n/useT";
import {
  namedTlsHosts,
  TLS_NOT_CHECKED_TONE,
  type VendorTlsAnswer,
} from "../../-object/vendor-tls";
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
  vendor?: VendorTlsAnswer | null;
}

/**
 * "Not checked" is its own colour, or it reads as the "no" beside it. A
 * certificate named and not served is a mistake, not the choice "none" is.
 */
const BARE_TONE: Record<"none" | "notChecked" | "plain", string> = {
  none: "text-fg-fnt",
  notChecked: TLS_NOT_CHECKED_TONE,
  plain: "text-warn",
};

/**
 * Whether an ingress terminates TLS.
 *
 * A certificate being present is configuration, not a lifecycle state, so it
 * reads as text: a green pill on every TLS row claimed something had gone
 * right, and left "No TLS" looking like a failure rather than a choice.
 */
export function TlsBadge({ tlsHosts, hasCatchAllTls, vendor }: TlsBadgeProps) {
  const t = useT();
  const vendorHosts = vendor?.hosts ?? [];
  const unchecked = vendor?.unchecked ?? [];
  const plain = vendor?.plain ?? [];
  const named = namedTlsHosts(tlsHosts, vendor);
  const catchAll = hasCatchAllTls && plain.length === 0;
  const explicitCount = named.length;

  if (explicitCount === 0 && !catchAll && vendorHosts.length === 0) {
    const bare =
      unchecked.length > 0 ? "notChecked" : plain.length > 0 ? "plain" : "none";
    const words = t("empty", bare === "notChecked" ? "tlsNotChecked" : "noTls");
    if (bare === "plain" && vendor?.plainWhy) {
      return (
        <Tooltip>
          <TooltipTrigger className={BARE_TONE.plain}>{words}</TooltipTrigger>
          <TooltipContent className="max-w-[42ch] text-xs">
            {vendor.plainWhy}
          </TooltipContent>
        </Tooltip>
      );
    }
    return <span className={BARE_TONE[bare]}>{words}</span>;
  }

  // The controller's answer is not a Secret in this cluster, so it is counted
  // apart from the ones that are and named in the tooltip.
  if (explicitCount === 0 && !catchAll) {
    return (
      <Tooltip>
        <TooltipTrigger className="text-fg-mid">
          {t("count", "hosts", { n: vendorHosts.length })}
        </TooltipTrigger>
        <TooltipContent>
          <div className="text-xs">
            {vendor && t("readings", "tlsFromVendor", { by: vendor.by })}
          </div>
          {vendorHosts.map((host) => (
            <div key={host} className="text-xs">
              {host}
            </div>
          ))}
          {unchecked.map((host) => (
            <div key={host} className="text-xs">
              {host} · {t("empty", "tlsNotChecked")}
            </div>
          ))}
        </TooltipContent>
      </Tooltip>
    );
  }

  // A catch-all certificate covers every host, whatever spec.tls also names.
  const label = catchAll
    ? t("empty", "tlsEveryHost")
    : t("count", "hosts", { n: explicitCount + vendorHosts.length });

  const hosts = [
    ...named,
    ...(catchAll ? [t("empty", "catchAllCertificate")] : []),
    ...vendorHosts.map((host) =>
      vendor ? t("readings", "tlsHostFrom", { host, by: vendor.by }) : host
    ),
    ...unchecked.map((host) => `${host} · ${t("empty", "tlsNotChecked")}`),
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
