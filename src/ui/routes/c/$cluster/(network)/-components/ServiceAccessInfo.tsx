import { Section, SectionBody, SectionHeader } from "@/components/ui/section";
import { Button } from "@/components/ui/button";
import { Copy, ExternalLink, Network } from "lucide-react";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import type { ServiceInfo } from "@/generated/types";
import { useT, type T } from "@/i18n/useT";
import { parts } from "@/i18n/parts";
import { None } from "@/components/ui/none";
import { openExternal } from "@/lib/open-external";
import { BalancerAddress } from "../../-object/BalancerAddress";

interface ServiceAccessInfoProps {
  service: ServiceInfo;
  /** Opens the page's port-forward dialog. */
  onForward: () => void;
}

/** One way in: an address to copy, or the balancer's reason it has none yet. */
type Way =
  | {
      label: string;
      address: string | null;
      open: boolean;
      hint: string;
    }
  | { label: string; balancer: true };

function waysIn(service: ServiceInfo, t: T): Way[] {
  const port = service.ports[0]?.port;
  const withPort = (host: string) => (port ? `${host}:${port}` : host);
  const ways: Way[] = [];

  if (service.type === "ExternalName") {
    ways.push({
      label: t("empty", "accessExternalName"),
      address: service.externalName,
      open: false,
      hint: t("empty", "accessExternalNameHint"),
    });
  }

  if (service.type === "LoadBalancer") {
    if (service.loadBalancerIps.length === 0) {
      ways.push({ label: t("empty", "accessExternalLb"), balancer: true });
    }
    for (const ip of service.loadBalancerIps) {
      ways.push({
        label: t("empty", "accessExternalLb"),
        address: `http://${ip}${port && port !== 80 ? `:${port}` : ""}`,
        open: true,
        hint: t("empty", "accessExternalLbHint"),
      });
    }
  }

  // A LoadBalancer Service is a NodePort one underneath, so both answer here.
  if (service.type === "NodePort" || service.type === "LoadBalancer") {
    for (const { nodePort } of service.ports) {
      if (nodePort === null) continue;
      ways.push({
        label: t("empty", "accessExternalNodePort"),
        address: `<any-node-ip>:${nodePort}`,
        open: false,
        hint: t("empty", "accessExternalNodePortHint"),
      });
    }
  }

  for (const ip of service.externalIps) {
    ways.push({
      label: t("columns", "externalIp"),
      address: withPort(ip),
      open: false,
      hint: t("empty", "accessExternalIpHint"),
    });
  }

  if (service.type !== "ExternalName") {
    ways.push(
      {
        label: t("empty", "accessInternalFullDns"),
        address: withPort(
          `${service.name}.${service.namespace}.svc.cluster.local`
        ),
        open: false,
        hint: t("empty", "accessInternalFullDnsHint"),
      },
      {
        label: t("empty", "accessInternalShort"),
        address: withPort(service.name),
        open: false,
        hint: t("empty", "accessInternalShortHint"),
      }
    );
  }
  return ways;
}

function AddressActions({ address, open }: { address: string; open: boolean }) {
  const t = useT();
  const copyToClipboard = useCopyToClipboard();
  return (
    <div className="flex items-center gap-2 ml-3">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => copyToClipboard(address)}
        title={t("action", "copy")}
      >
        <Copy className="h-4 w-4" />
      </Button>
      {open && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void openExternal(address, address, t)}
          title={t("action", "openInBrowser")}
        >
          <ExternalLink className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

export function ServiceAccessInfo({
  service,
  onForward,
}: ServiceAccessInfoProps) {
  const t = useT();

  return (
    <Section>
      <SectionHeader title={t("nav", "reachableAt")} />
      <SectionBody className="flex flex-col divide-y divide-hair">
        {waysIn(service, t).map((way, idx) => (
          <div key={idx} className="flex items-center justify-between py-3">
            <div className="flex-1 min-w-0 flex flex-col gap-1">
              <span className="text-sm font-medium">{way.label}</span>
              {"balancer" in way ? (
                <BalancerAddress service={service} />
              ) : (
                <>
                  {way.address === null ? (
                    <None className="text-sm" />
                  ) : (
                    <code className="text-sm font-mono text-fg-mid break-all">
                      {way.address}
                    </code>
                  )}
                  <p className="text-xs text-fg-mut">{way.hint}</p>
                </>
              )}
            </div>
            {"address" in way && way.address !== null && (
              <AddressActions address={way.address} open={way.open} />
            )}
          </div>
        ))}
      </SectionBody>

      {service.type === "ClusterIP" && service.ports.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-fg-mut">
            {parts(t("empty", "clusterIpOnlyInside"), {
              type: <strong>ClusterIP</strong>,
            })}
          </p>
          <Button variant="outline" size="sm" onClick={onForward}>
            <Network className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t("action", "portForward")}
          </Button>
        </div>
      )}
    </Section>
  );
}
