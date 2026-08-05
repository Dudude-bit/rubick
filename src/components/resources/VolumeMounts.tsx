/**
 * Volume Mounts Component
 *
 * Displays volume mounts in a collapsible card with expandable content
 * for Secret and ConfigMap volumes.
 */

import { useState, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { Section, SectionHeader } from "@/components/ui/section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ChevronDown,
  ChevronRight,
  Lock,
  FileKey,
  Database,
  FolderOpen,
  Box,
  Loader2,
} from "lucide-react";
import type { VolumeReference } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import { SecretKeyValueItem } from "@/components/ui/secret-value";

interface VolumeMountsProps {
  /** Volume mount references */
  volumes: VolumeReference[];
  /** Namespace for fetching Secret/ConfigMap data */
  namespace?: string;
}

// Cache for ConfigMap and Secret data
type DataCache = Record<string, Record<string, string>>;

type VolumeType =
  | "Secret"
  | "ConfigMap"
  | "PersistentVolumeClaim"
  | "EmptyDir"
  | "Other";

function getVolumeType(kind: string): VolumeType {
  switch (kind.toLowerCase()) {
    case "secret":
      return "Secret";
    case "configmap":
      return "ConfigMap";
    case "persistentvolumeclaim":
    case "pvc":
      return "PersistentVolumeClaim";
    case "emptydir":
      return "EmptyDir";
    default:
      return "Other";
  }
}

function getVolumeIcon(volumeType: VolumeType) {
  switch (volumeType) {
    case "Secret":
      return <Lock className="h-4 w-4 text-fg-mut" />;
    case "ConfigMap":
      return <FileKey className="h-4 w-4 text-fg-mut" />;
    case "PersistentVolumeClaim":
      return <Database className="h-4 w-4 text-fg-mut" />;
    case "EmptyDir":
      return <FolderOpen className="h-4 w-4 text-fg-mut" />;
    default:
      return <Box className="h-4 w-4 text-fg-mut" />;
  }
}

function getVolumeBadgeVariant(
  volumeType: VolumeType
): "default" | "secondary" | "outline" | "destructive" {
  switch (volumeType) {
    case "Secret":
      return "destructive";
    case "ConfigMap":
      return "secondary";
    case "PersistentVolumeClaim":
      return "default";
    default:
      return "outline";
  }
}

interface VolumeMountItemProps {
  volume: VolumeReference;
  volumeType: VolumeType;
  secretData?: Record<string, string>;
  configMapData?: Record<string, string>;
  showSecrets: boolean;
  isLoadingSecret: boolean;
  isLoadingConfigMap: boolean;
}

function VolumeMountItem({
  volume,
  volumeType,
  secretData,
  configMapData,
  showSecrets,
  isLoadingSecret,
  isLoadingConfigMap,
}: VolumeMountItemProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [userRevealedKeys, setUserRevealedKeys] = useState<Set<string>>(
    new Set()
  );

  const hasExpandableContent =
    (volumeType === ResourceType.Secret && secretData) ||
    (volumeType === ResourceType.ConfigMap && configMapData);

  // Derived: when the parent's "show all" toggle is on, every key in
  // the loaded secretData is revealed. Otherwise we honour the user's
  // per-key reveal toggles. Computing this during render avoids the
  // useEffect → setState cascade that the prior implementation used.
  const revealedKeys =
    showSecrets && secretData
      ? new Set(Object.keys(secretData))
      : userRevealedKeys;

  const toggleReveal = (key: string) => {
    if (showSecrets) {
      // No-op when "show all" is active — the derived value above is
      // already the union of every key, so toggling does nothing
      // visible.
      return;
    }
    setUserRevealedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const isLoading =
    (volumeType === ResourceType.Secret && isLoadingSecret) ||
    (volumeType === ResourceType.ConfigMap && isLoadingConfigMap);

  return (
    <div className="rounded border border-hair p-3 space-y-2">
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {getVolumeIcon(volumeType)}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-sm font-medium truncate">
                  {volume.mountPath}
                </span>
                {volume.subPath && (
                  <Badge variant="outline" className="text-xs">
                    subPath: {volume.subPath}
                  </Badge>
                )}
              </div>
              <div className="text-xs text-fg-mut mt-0.5">
                {volume.name}
                {volume.containerName && (
                  <span className="ml-2 opacity-70">
                    ({volume.containerName})
                  </span>
                )}
              </div>
            </div>
            <Badge variant={getVolumeBadgeVariant(volumeType)} className="ml-2">
              {volumeType}
            </Badge>
          </div>
          {hasExpandableContent && (
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0 ml-2">
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : isExpanded ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </Button>
            </CollapsibleTrigger>
          )}
        </div>
        {hasExpandableContent && (
          <CollapsibleContent>
            <div className="mt-3 pt-3 border-t border-hair space-y-2">
              {volumeType === ResourceType.Secret && secretData && (
                <>
                  {Object.entries(secretData).length > 0 ? (
                    Object.entries(secretData).map(([key, value]) => (
                      <SecretKeyValueItem
                        key={key}
                        keyName={key}
                        value={value}
                        isRevealed={revealedKeys.has(key)}
                        onToggleReveal={() => toggleReveal(key)}
                        isLoading={isLoadingSecret}
                      />
                    ))
                  ) : (
                    <p className="text-sm text-fg-mut">
                      No data keys in secret
                    </p>
                  )}
                </>
              )}
              {volumeType === ResourceType.ConfigMap && configMapData && (
                <>
                  {Object.entries(configMapData).length > 0 ? (
                    Object.entries(configMapData).map(([key, value]) => (
                      <div
                        key={key}
                        className="rounded border border-hair p-3 space-y-2"
                      >
                        <div className="flex items-center gap-2">
                          <FileKey className="h-4 w-4 text-fg-mut" />
                          <span className="font-medium">{key}</span>
                          <Badge variant="secondary" className="text-xs">
                            {value.length} chars
                          </Badge>
                        </div>
                        <pre className="bg-hover p-2 rounded text-sm overflow-x-auto whitespace-pre-wrap break-all font-mono max-h-48">
                          {isLoadingConfigMap ? "Loading..." : value}
                        </pre>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-fg-mut">
                      No data keys in configmap
                    </p>
                  )}
                </>
              )}
            </div>
          </CollapsibleContent>
        )}
      </Collapsible>
    </div>
  );
}

export function VolumeMounts({ volumes, namespace }: VolumeMountsProps) {
  const [showSecrets, setShowSecrets] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);

  const hasVolumes = volumes.length > 0;

  // Get unique secret and configMap names
  const { secretNames, configMapNames, hasSecrets } = useMemo(() => {
    const secrets = new Set<string>();
    const configMaps = new Set<string>();

    for (const vol of volumes) {
      const volumeType = getVolumeType(vol.kind);
      if (volumeType === ResourceType.Secret) {
        secrets.add(vol.name);
      } else if (volumeType === ResourceType.ConfigMap) {
        configMaps.add(vol.name);
      }
    }

    return {
      secretNames: Array.from(secrets),
      configMapNames: Array.from(configMaps),
      hasSecrets: secrets.size > 0,
    };
  }, [volumes]);

  // Per-name parallel queries via useQueries. Each ConfigMap/Secret
  // gets its own queryKey so a slow one doesn't block fast ones (the
  // previous Promise.all blocked on the slowest), and cache survives
  // navigation away and back. staleTime: Infinity matches the prior
  // behaviour of "fetched once per session" — these reflect data on
  // the cluster that doesn't change frequently. retry: false + the
  // ?? {} fallback below keep the original silent-error behaviour
  // (a missing/forbidden CM shows as empty, not a toast).
  const configMapQueries = useQueries({
    queries: configMapNames.map((name) => ({
      queryKey: ["configmap-data", namespace, name] as const,
      queryFn: () => commands.getConfigmapData(name, namespace!),
      enabled: !!namespace,
      staleTime: Infinity,
      retry: false,
    })),
  });

  const secretQueries = useQueries({
    queries: secretNames.map((name) => ({
      queryKey: ["secret-data", namespace, name] as const,
      queryFn: () => commands.getSecretData(name, namespace!),
      enabled: !!namespace && showSecrets,
      staleTime: Infinity,
      retry: false,
    })),
  });

  const configMapCache = useMemo<DataCache>(() => {
    const cache: DataCache = {};
    configMapNames.forEach((name, i) => {
      const q = configMapQueries[i];
      if (q?.data) cache[name] = q.data;
      else if (q?.isError) cache[name] = {};
    });
    return cache;
  }, [configMapNames, configMapQueries]);

  const secretCache = useMemo<DataCache>(() => {
    const cache: DataCache = {};
    secretNames.forEach((name, i) => {
      const q = secretQueries[i];
      if (q?.data) cache[name] = q.data;
      else if (q?.isError) cache[name] = {};
    });
    return cache;
  }, [secretNames, secretQueries]);

  const loadingConfigMaps = useMemo<Set<string>>(() => {
    const set = new Set<string>();
    configMapNames.forEach((name, i) => {
      if (configMapQueries[i]?.isFetching) set.add(name);
    });
    return set;
  }, [configMapNames, configMapQueries]);

  const loadingSecrets = useMemo<Set<string>>(() => {
    const set = new Set<string>();
    secretNames.forEach((name, i) => {
      if (secretQueries[i]?.isFetching) set.add(name);
    });
    return set;
  }, [secretNames, secretQueries]);

  return (
    <Collapsible asChild open={isExpanded} onOpenChange={setIsExpanded}>
      <Section>
        <SectionHeader
          title="Volume Mounts"
          count={hasVolumes ? volumes.length : undefined}
          actions={
            <>
              {hasSecrets && (
                <div className="flex items-center gap-2">
                  {loadingSecrets.size > 0 && (
                    <Loader2 className="h-4 w-4 animate-spin text-fg-mut" />
                  )}
                  <Switch
                    id="show-volume-secrets"
                    checked={showSecrets}
                    onCheckedChange={setShowSecrets}
                    disabled={loadingSecrets.size > 0}
                  />
                  <Label htmlFor="show-volume-secrets" className="text-sm">
                    Show secrets
                  </Label>
                </div>
              )}
              <CollapsibleTrigger
                aria-label={isExpanded ? "Collapse" : "Expand"}
                className="ml-1 text-fg-mut hover:text-fg"
              >
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </CollapsibleTrigger>
            </>
          }
        />
        <CollapsibleContent>
          {!hasVolumes ? (
            <p className="text-sm text-fg-mut">No volume mounts defined</p>
          ) : (
            <div className="flex flex-col gap-3">
              {volumes.map((volume) => {
                const volumeType = getVolumeType(volume.kind);
                const secretData =
                  volumeType === ResourceType.Secret
                    ? secretCache[volume.name]
                    : undefined;
                const configMapData =
                  volumeType === ResourceType.ConfigMap
                    ? configMapCache[volume.name]
                    : undefined;

                return (
                  <VolumeMountItem
                    key={`${volume.name}-${volume.mountPath}`}
                    volume={volume}
                    volumeType={volumeType}
                    secretData={secretData}
                    configMapData={configMapData}
                    showSecrets={showSecrets}
                    isLoadingSecret={loadingSecrets.has(volume.name)}
                    isLoadingConfigMap={loadingConfigMaps.has(volume.name)}
                  />
                );
              })}
            </div>
          )}
        </CollapsibleContent>
      </Section>
    </Collapsible>
  );
}
