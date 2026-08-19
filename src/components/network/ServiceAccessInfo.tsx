import { Section, SectionBody, SectionHeader } from "@/components/ui/section";
import { Button } from "@/components/ui/button";
import { Copy, ExternalLink } from "lucide-react";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import type { ServiceInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";

interface ServiceAccessInfoProps {
  service: ServiceInfo;
}

export function ServiceAccessInfo({ service }: ServiceAccessInfoProps) {
  const t = useT();
  const copyToClipboard = useCopyToClipboard();

  const internalDns = `${service.name}.${service.namespace}.svc.cluster.local`;
  const shortDns = `${service.name}`;

  // Build access URLs based on service type
  const accessItems: Array<{
    label: string;
    url: string;
    canOpen: boolean;
    description: string;
  }> = [];

  if (service.type === "LoadBalancer" && service.loadBalancerIps.length > 0) {
    const port = service.ports[0]?.port;
    const url = `http://${service.loadBalancerIps[0]}${port && port !== 80 ? `:${port}` : ""}`;
    accessItems.push({
      label: "External (LoadBalancer)",
      url,
      canOpen: true,
      description: "Access via load balancer IP",
    });
  }

  if (service.type === "NodePort" && service.ports.some((p) => p.nodePort)) {
    const nodePort = service.ports.find((p) => p.nodePort)?.nodePort;
    accessItems.push({
      label: "External (NodePort)",
      url: `<any-node-ip>:${nodePort}`,
      canOpen: false,
      description: "Access via any cluster node IP",
    });
  }

  if (service.type === "ExternalName") {
    accessItems.push({
      label: "External Name",
      url: service.clusterIp || "N/A",
      canOpen: false,
      description: "DNS alias to external service",
    });
  }

  // Internal access for all types except ExternalName
  if (service.type !== "ExternalName") {
    const port = service.ports[0]?.port;
    accessItems.push({
      label: "Internal (full DNS)",
      url: `${internalDns}${port ? `:${port}` : ""}`,
      canOpen: false,
      description: "From any namespace in cluster",
    });
    accessItems.push({
      label: "Internal (short)",
      url: `${shortDns}${port ? `:${port}` : ""}`,
      canOpen: false,
      description: "From same namespace only",
    });
  }

  return (
    <Section>
      {/* "How to Access This Service" was the tab label padded out to six
          Title Case words. This names the thing under it instead, and says
          it the way the ingress page already says it. */}
      <SectionHeader title="Reachable at" />
      <SectionBody className="flex flex-col divide-y divide-hair">
        {accessItems.map((item, idx) => (
          <div key={idx} className="flex items-center justify-between py-3">
            <div className="flex-1 min-w-0 flex flex-col gap-1">
              <span className="text-sm font-medium">{item.label}</span>
              <code className="text-sm font-mono text-fg-mid break-all">
                {item.url}
              </code>
              <p className="text-xs text-fg-mut">{item.description}</p>
            </div>
            <div className="flex items-center gap-2 ml-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => copyToClipboard(item.url)}
                title={t("action", "copy")}
              >
                <Copy className="h-4 w-4" />
              </Button>
              {item.canOpen && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => window.open(item.url, "_blank", "noreferrer")}
                  title={t("action", "openInBrowser")}
                >
                  <ExternalLink className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        ))}
      </SectionBody>

      {service.type === "ClusterIP" && (
        <p className="text-sm text-fg-mut">
          <strong>ClusterIP</strong> services are only accessible from within
          the cluster. Use port-forward for local development:
          <code className="ml-1 text-xs bg-hover px-1 rounded">
            kubectl port-forward svc/{service.name}{" "}
            {service.ports[0]?.port || 8080}:{service.ports[0]?.port || 8080}
          </code>
        </p>
      )}
    </Section>
  );
}
