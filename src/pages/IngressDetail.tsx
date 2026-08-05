import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { YamlTabContent } from "@/components/resources/YamlTabContent";
import {
  ResourceDetailLayout,
  InfoCard,
} from "@/components/resources/ResourceDetailLayout";
import { LinkedResource } from "@/components/network";
import { useResourceDetail } from "@/hooks";
import { ResourceType } from "@/lib/resource-registry";
import { REFRESH_INTERVALS } from "@/lib/refresh";
import {
  Globe,
  ExternalLink,
  Shield,
  Copy,
  Link2,
  Tag,
  FileText,
  ArrowRight,
  AlertTriangle,
  Info,
  Clock,
  Calendar,
} from "lucide-react";
import { RealtimeAge } from "@/components/ui/realtime";
import { commands } from "@/lib/commands";
import type {
  IngressInfo,
  IngressRule,
  EventInfo,
  EventFilters,
} from "@/generated/types";
import { normalizeTauriError } from "@/lib/error-utils";
import { useQuery } from "@tanstack/react-query";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { cn } from "@/lib/utils";

// Helper to generate full URLs from ingress rules
interface AccessUrl {
  fullUrl: string;
  host: string;
  displayHost: string;
  path: string;
  pathType: string;
  backendService: string;
  backendPort: string;
  resourceBackend: string | null;
  isHttps: boolean;
  tlsReason: "explicit" | "catch-all" | null;
}

function generateAccessUrls(
  rules: IngressRule[],
  tlsHosts: string[],
  hasCatchAllTls: boolean
): AccessUrl[] {
  const urls: AccessUrl[] = [];

  for (const rule of rules) {
    const isWildcard = rule.host === "*" || !rule.host;
    const displayHost = isWildcard ? "All hosts" : rule.host;
    const actualHost = isWildcard ? "" : rule.host;

    // TLS detection: host is in tlsHosts, or there's a catch-all TLS config
    const isHttps = tlsHosts.includes(rule.host) || hasCatchAllTls;
    const scheme = isHttps ? "https" : "http";
    const tlsReason = tlsHosts.includes(rule.host)
      ? "explicit"
      : hasCatchAllTls
        ? "catch-all"
        : null;

    for (const path of rule.paths) {
      const fullUrl = actualHost
        ? `${scheme}://${actualHost}${path.path}`
        : `${scheme}://<host>${path.path}`;
      urls.push({
        fullUrl,
        host: rule.host,
        displayHost,
        path: path.path,
        pathType: path.pathType,
        backendService: path.backendService,
        backendPort: path.backendPort,
        resourceBackend: path.resourceBackend,
        isHttps,
        tlsReason,
      });
    }
  }

  return urls;
}

export function IngressDetail() {
  const copyToClipboard = useCopyToClipboard();
  const {
    name,
    namespace,
    resource: ingress,
    isLoading,
    error,
    yaml: ingressYaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
  } = useResourceDetail<IngressInfo>({
    resourceKind: ResourceType.Ingress,
    fetchResource: async (name, ns) => {
      try {
        return await commands.getIngress(name, ns);
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    deleteResource: async (name, ns) => {
      try {
        await commands.deleteIngress(name, ns);
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    defaultTab: "access",
  });

  const rules = ingress?.rules ?? [];
  const tlsHosts = ingress?.tlsHosts ?? [];
  const tlsConfigs = ingress?.tlsConfigs ?? [];
  const loadBalancerIps = ingress?.loadBalancerIps ?? [];
  const labels = ingress?.labels ?? {};
  const annotations = ingress?.annotations ?? {};
  const hasCatchAllTls = ingress?.hasCatchAllTls ?? false;
  const accessUrls = generateAccessUrls(rules, tlsHosts, hasCatchAllTls);

  // Fetch events for this ingress
  const {
    data: events = [],
    isLoading: eventsLoading,
    error: eventsError,
    refetch: refetchEvents,
  } = useQuery({
    queryKey: ["ingress-events", namespace, name],
    queryFn: async () => {
      const filters: EventFilters = {
        namespace: namespace || null,
        involved_object_name: name || null,
        involved_object_kind: ResourceType.Ingress,
        event_type: null,
        field_selector: null,
        limit: 100,
      };
      return await commands.listEvents(filters);
    },
    enabled: !!name && !!namespace,
    refetchInterval: REFRESH_INTERVALS.overview,
  });

  const tabs = [
    {
      id: "access",
      label: "Access",
      content: (
        <div className="space-y-4">
          {/* Access URLs Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Link2 className="h-5 w-5" />
                How to Access This Ingress
              </CardTitle>
            </CardHeader>
            <CardContent>
              {accessUrls.length > 0 ? (
                <div className="space-y-3">
                  {accessUrls.map((url, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between rounded-lg border p-3 bg-muted/30 hover:bg-muted/50 transition-colors"
                    >
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <Badge
                          variant="secondary"
                          className={
                            url.isHttps
                              ? "bg-green-500/10 text-green-500"
                              : "bg-yellow-500/10 text-yellow-500"
                          }
                        >
                          {url.isHttps ? "HTTPS" : "HTTP"}
                        </Badge>
                        <div className="flex items-center gap-1 flex-1 min-w-0">
                          <Badge variant="outline" className="shrink-0">
                            {url.displayHost}
                          </Badge>
                          <code className="text-sm font-mono truncate">
                            {url.path}
                          </code>
                        </div>
                        <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="text-sm text-muted-foreground shrink-0">
                          {url.resourceBackend ? (
                            `Resource: ${url.resourceBackend}`
                          ) : url.backendService ? (
                            <LinkedResource
                              resourceType={ResourceType.Service}
                              name={url.backendService}
                              namespace={ingress?.namespace || ""}
                              port={url.backendPort}
                            />
                          ) : (
                            "No backend"
                          )}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 ml-3">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            copyToClipboard(
                              url.host !== "*" && url.host
                                ? url.fullUrl
                                : url.path
                            )
                          }
                          title="Copy URL"
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                        {url.host !== "*" && url.host && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              window.open(url.fullUrl, "_blank", "noreferrer")
                            }
                            title="Open in Browser"
                          >
                            <ExternalLink className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground">
                  No access URLs available
                </p>
              )}

              {/* Load Balancer / External IP info */}
              {loadBalancerIps.length > 0 && (
                <div className="mt-4 pt-4 border-t">
                  <h4 className="text-sm font-medium mb-2">
                    External Addresses
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {loadBalancerIps.map((ip, idx) => (
                      <Badge key={idx} variant="outline" className="font-mono">
                        {ip}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      ),
    },
    {
      id: "rules",
      label: "Rules",
      content: (
        <Card>
          <CardHeader>
            <CardTitle>Ingress Rules</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {rules.map((rule, idx) => {
                const isWildcard = rule.host === "*" || !rule.host;
                const displayHost = isWildcard ? "All hosts" : rule.host;
                const hasTls = tlsHosts.includes(rule.host) || hasCatchAllTls;

                return (
                  <div key={idx} className="rounded-lg border p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <Badge variant="outline">{displayHost}</Badge>
                      {hasTls && (
                        <Badge className="bg-green-500/10 text-green-500 border-green-500/20">
                          <Shield className="h-3 w-3 mr-1" />
                          TLS
                        </Badge>
                      )}
                    </div>
                    <div className="space-y-2">
                      {rule.paths.map((path, pathIdx) => (
                        <div
                          key={pathIdx}
                          className="flex items-center justify-between rounded border p-2 bg-muted/30"
                        >
                          <div className="flex items-center gap-2">
                            <code className="text-sm">{path.path}</code>
                            <Badge variant="secondary" className="text-xs">
                              {path.pathType}
                            </Badge>
                          </div>
                          <div className="text-sm text-muted-foreground flex items-center gap-1">
                            →{" "}
                            {path.resourceBackend ? (
                              `Resource: ${path.resourceBackend}`
                            ) : path.backendService ? (
                              <LinkedResource
                                resourceType={ResourceType.Service}
                                name={path.backendService}
                                namespace={ingress?.namespace || ""}
                                port={path.backendPort}
                              />
                            ) : (
                              "No backend"
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
              {rules.length === 0 && (
                <p className="text-muted-foreground">No rules defined</p>
              )}
            </div>
          </CardContent>
        </Card>
      ),
    },
    {
      id: "tls",
      label: "TLS",
      content: (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              TLS Configuration
            </CardTitle>
          </CardHeader>
          <CardContent>
            {tlsConfigs.length > 0 ? (
              <div className="space-y-4">
                {/* Explicit TLS Hosts */}
                {tlsConfigs.filter((c) => !c.isCatchAll).length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium mb-2">
                      Explicit TLS Hosts
                    </h4>
                    <div className="space-y-3">
                      {tlsConfigs
                        .filter((c) => !c.isCatchAll)
                        .map((config, idx) => (
                          <div key={idx} className="rounded-lg border p-4">
                            <div className="flex items-center gap-2 mb-3">
                              <Shield className="h-4 w-4 text-green-500" />
                              <span className="font-medium">
                                Secret:{" "}
                                {config.secretName || "(auto-generated)"}
                              </span>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {config.hosts.map((host, hostIdx) => (
                                <Badge
                                  key={hostIdx}
                                  variant="outline"
                                  className="font-mono"
                                >
                                  {host}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        ))}
                    </div>
                  </div>
                )}

                {/* Catch-all TLS */}
                {tlsConfigs.filter((c) => c.isCatchAll).length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-yellow-500" />
                      Catch-all TLS
                    </h4>
                    <div className="space-y-3">
                      {tlsConfigs
                        .filter((c) => c.isCatchAll)
                        .map((config, idx) => (
                          <div
                            key={idx}
                            className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4"
                          >
                            <div className="flex items-center gap-2 mb-2">
                              <Shield className="h-4 w-4 text-yellow-500" />
                              <span className="font-medium">
                                Secret:{" "}
                                {config.secretName || "(auto-generated)"}
                              </span>
                            </div>
                            <p className="text-sm text-muted-foreground">
                              Applies to all hosts not explicitly listed above
                            </p>
                          </div>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-muted-foreground">No TLS configured</p>
            )}
          </CardContent>
        </Card>
      ),
    },
    {
      id: "metadata",
      label: "Metadata",
      content: (
        <div className="space-y-4">
          {/* Labels */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Tag className="h-5 w-5" />
                Labels
              </CardTitle>
            </CardHeader>
            <CardContent>
              {Object.keys(labels).length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {Object.entries(labels).map(([key, value]) => (
                    <Badge key={key} variant="outline" className="text-xs">
                      <span className="font-medium">{key}</span>
                      <span className="mx-1">=</span>
                      <span>{value}</span>
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground">No labels</p>
              )}
            </CardContent>
          </Card>

          {/* Annotations */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5" />
                Annotations
              </CardTitle>
            </CardHeader>
            <CardContent>
              {Object.keys(annotations).length > 0 ? (
                <div className="space-y-2">
                  {Object.entries(annotations).map(([key, value]) => (
                    <div
                      key={key}
                      className="flex flex-col gap-1 rounded border p-2 bg-muted/30"
                    >
                      <code className="text-xs font-medium text-muted-foreground">
                        {key}
                      </code>
                      <code className="text-sm break-all">{value}</code>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground">No annotations</p>
              )}
            </CardContent>
          </Card>
        </div>
      ),
    },
    {
      id: "events",
      label: "Events",
      content: (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              Events
            </CardTitle>
          </CardHeader>
          <CardContent>
            {eventsError ? (
              <div className="flex items-center justify-between p-3 rounded-lg border border-yellow-500/30 bg-yellow-500/5">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-yellow-500" />
                  <span className="text-sm">Failed to load events</span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => refetchEvents()}
                >
                  Retry
                </Button>
              </div>
            ) : eventsLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : events.length > 0 ? (
              <div className="space-y-3">
                {events.map((event: EventInfo) => {
                  const isWarning = event.type === "Warning";
                  return (
                    <div
                      key={event.uid}
                      className={cn(
                        "rounded-lg border p-3",
                        isWarning
                          ? "border-yellow-500/50 bg-yellow-500/5"
                          : "border-border"
                      )}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2">
                          {isWarning ? (
                            <AlertTriangle className="h-4 w-4 text-yellow-500" />
                          ) : (
                            <Info className="h-4 w-4 text-blue-500" />
                          )}
                          <span className="font-medium">{event.reason}</span>
                        </div>
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {event.lastTimestamp
                            ? new Date(event.lastTimestamp).toLocaleString()
                            : "Unknown"}
                          {(event.count || 0) > 1 && (
                            <Badge variant="secondary" className="ml-2">
                              x{event.count}
                            </Badge>
                          )}
                        </div>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {event.message}
                      </p>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-muted-foreground">No events found</p>
            )}
          </CardContent>
        </Card>
      ),
    },
    {
      id: "yaml",
      label: "YAML",
      content: (
        <YamlTabContent
          title="Ingress YAML"
          yaml={ingressYaml}
          resourceKind={ResourceType.Ingress}
          resourceName={name || ""}
          namespace={namespace}
          onCopy={copyYaml}
        />
      ),
    },
  ];

  return (
    <ResourceDetailLayout
      resource={ingress}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.Ingress}
      title={ingress?.name || name || ""}
      namespace={ingress?.namespace || namespace}
      badges={
        <>
          {ingress?.className && (
            <Badge variant="outline">{ingress.className}</Badge>
          )}
          {(tlsHosts.length > 0 || tlsConfigs.length > 0) && (
            <Badge className="bg-green-500/10 text-green-500 border-green-500/20">
              <Shield className="mr-1 h-3 w-3" />
              TLS
            </Badge>
          )}
          {ingress?.createdAt && (
            <Badge variant="outline" className="gap-1">
              <Calendar className="h-3 w-3" />
              <RealtimeAge timestamp={ingress.createdAt} />
            </Badge>
          )}
        </>
      }
      icon={<Globe className="h-8 w-8 text-muted-foreground" />}
      onBack={goBack}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabs={tabs}
    >
      <div className="grid gap-4 md:grid-cols-4">
        <InfoCard title="Ingress Class">
          <div className="text-xl font-bold">
            {ingress?.className || "default"}
          </div>
        </InfoCard>

        <InfoCard title="Load Balancer">
          <div className="text-xl font-bold">
            {loadBalancerIps.length > 0 ? loadBalancerIps[0] : "Pending"}
          </div>
          {loadBalancerIps.length > 1 && (
            <div className="text-xs text-muted-foreground">
              +{loadBalancerIps.length - 1} more
            </div>
          )}
        </InfoCard>

        <InfoCard title="Rules">
          <div className="text-xl font-bold">{rules.length}</div>
        </InfoCard>

        <InfoCard title="Access URLs">
          <div className="text-xl font-bold">{accessUrls.length}</div>
        </InfoCard>
      </div>
    </ResourceDetailLayout>
  );
}
