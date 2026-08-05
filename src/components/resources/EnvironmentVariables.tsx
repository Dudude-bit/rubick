import { useState, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { Section, SectionHeader } from "@/components/ui/section";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import type {
  EnvVarInfo,
  EnvFromInfo,
  EnvVarSourceType,
} from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import { ResourceLink } from "@/components/resources/detail-blocks";
import { MaskedValue } from "@/components/ui/masked-value";

/**
 * Where a variable's value came from.
 *
 * Printed as a word plus a link, never as a badge: a source is a fact about
 * the variable, not a lifecycle status, and a column of tinted pills reads as
 * a column of alarms.
 */
type SourceType =
  | "direct"
  | "secret"
  | "configmap"
  | "field"
  | "resource"
  | "envFromSecret"
  | "envFromConfigMap";

const SOURCE_LABEL: Record<SourceType, string> = {
  direct: "inline",
  secret: "secret",
  configmap: "configmap",
  field: "fieldRef",
  resource: "resourceRef",
  envFromSecret: "secret · envFrom",
  envFromConfigMap: "configmap · envFrom",
};

function SourceCell({
  type,
  name,
  namespace,
}: {
  type: SourceType;
  name?: string;
  namespace?: string;
}) {
  const isSecret = type === "secret" || type === "envFromSecret";
  const isConfigMap = type === "configmap" || type === "envFromConfigMap";
  return (
    <span className="text-[11px] text-fg-fnt">
      {SOURCE_LABEL[type]}
      {name && " "}
      {name &&
        (namespace && (isSecret || isConfigMap) ? (
          <ResourceLink
            kind={isSecret ? ResourceType.Secret : ResourceType.ConfigMap}
            name={name}
            namespace={namespace}
          />
        ) : (
          <span className="font-mono text-fg-mut">{name}</span>
        ))}
    </span>
  );
}

interface EnvironmentVariablesProps {
  env: EnvVarInfo[];
  envFrom: EnvFromInfo[];
  containerName?: string;
  namespace?: string;
}

// Cache for ConfigMap and Secret data
type DataCache = Record<string, Record<string, string>>;

// Filter options for source types
type FilterOption =
  | "all"
  | "direct"
  | "secret"
  | "configmap"
  | "field"
  | "resource"
  | "envFrom";

function mapSourceType(sourceType: EnvVarSourceType): SourceType {
  switch (sourceType) {
    case "secretKeyRef":
      return "secret";
    case "configMapKeyRef":
      return "configmap";
    case "fieldRef":
      return "field";
    case "resourceFieldRef":
      return "resource";
  }
}

// Expanded env var that includes envFrom-sourced variables
interface ExpandedEnvVar {
  name: string;
  value: string | null;
  sourceType: SourceType;
  sourceName?: string;
  sourceKey?: string;
  fieldPath?: string;
  resource?: string;
  isFromEnvFrom?: boolean;
}

export function EnvironmentVariables({
  env,
  envFrom,
  containerName,
  namespace,
}: EnvironmentVariablesProps) {
  const [showSecrets, setShowSecrets] = useState(false);
  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(
    new Set()
  );
  const [isExpanded, setIsExpanded] = useState(true);
  const [filter, setFilter] = useState<FilterOption>("all");

  const hasEnvVars = env.length > 0 || envFrom.length > 0;

  // Get unique secret and configMap names that need to be fetched
  const {
    secretNames,
    configMapNames,
    envFromSecretNames,
    envFromConfigMapNames,
  } = useMemo(() => {
    const secrets = new Set<string>();
    const configMaps = new Set<string>();
    const envFromSecrets = new Set<string>();
    const envFromCMs = new Set<string>();

    // From env vars
    for (const envVar of env) {
      if (
        envVar.valueFrom?.sourceType === "secretKeyRef" &&
        envVar.valueFrom.name
      ) {
        secrets.add(envVar.valueFrom.name);
      }
      if (
        envVar.valueFrom?.sourceType === "configMapKeyRef" &&
        envVar.valueFrom.name
      ) {
        configMaps.add(envVar.valueFrom.name);
      }
    }

    // From envFrom
    for (const ef of envFrom) {
      if (ef.secretRef) {
        envFromSecrets.add(ef.secretRef);
      }
      if (ef.configMapRef) {
        envFromCMs.add(ef.configMapRef);
      }
    }

    return {
      secretNames: Array.from(secrets),
      configMapNames: Array.from(configMaps),
      envFromSecretNames: Array.from(envFromSecrets),
      envFromConfigMapNames: Array.from(envFromCMs),
    };
  }, [env, envFrom]);

  // Combine all secret names for fetching
  const allSecretNames = useMemo(() => {
    return [...new Set([...secretNames, ...envFromSecretNames])];
  }, [secretNames, envFromSecretNames]);

  // Combine all configMap names for fetching
  const allConfigMapNames = useMemo(() => {
    return [...new Set([...configMapNames, ...envFromConfigMapNames])];
  }, [configMapNames, envFromConfigMapNames]);

  const secretEnvVars = env.filter(
    (e) => e.valueFrom?.sourceType === "secretKeyRef"
  );
  const hasSecrets =
    secretEnvVars.length > 0 || envFrom.some((ef) => ef.secretRef);

  // Per-name parallel queries via useQueries. See VolumeMounts.tsx
  // for the reasoning behind staleTime: Infinity + retry: false +
  // silent ?? {} fallback — same shape applies here. The original
  // `loadingConfigMaps` / `loadingSecrets` were single booleans (any
  // in-flight); we derive them from `.some(isFetching)` to preserve
  // that semantic.
  const configMapQueries = useQueries({
    queries: allConfigMapNames.map((name) => ({
      queryKey: ["configmap-data", namespace, name] as const,
      queryFn: () => commands.getConfigmapData(name, namespace!),
      enabled: !!namespace,
      staleTime: Infinity,
      retry: false,
    })),
  });

  const secretQueries = useQueries({
    queries: allSecretNames.map((name) => ({
      queryKey: ["secret-data", namespace, name] as const,
      queryFn: () => commands.getSecretData(name, namespace!),
      enabled: !!namespace && showSecrets,
      staleTime: Infinity,
      retry: false,
    })),
  });

  const configMapCache = useMemo<DataCache>(() => {
    const cache: DataCache = {};
    allConfigMapNames.forEach((name, i) => {
      const q = configMapQueries[i];
      if (q?.data) cache[name] = q.data;
      else if (q?.isError) cache[name] = {};
    });
    return cache;
  }, [allConfigMapNames, configMapQueries]);

  const secretCache = useMemo<DataCache>(() => {
    const cache: DataCache = {};
    allSecretNames.forEach((name, i) => {
      const q = secretQueries[i];
      if (q?.data) cache[name] = q.data;
      else if (q?.isError) cache[name] = {};
    });
    return cache;
  }, [allSecretNames, secretQueries]);

  const loadingConfigMaps = configMapQueries.some((q) => q.isFetching);
  const loadingSecrets = secretQueries.some((q) => q.isFetching);

  // Build expanded env vars list including envFrom-sourced variables
  const expandedEnvVars = useMemo((): ExpandedEnvVar[] => {
    const result: ExpandedEnvVar[] = [];

    // Add envFrom-sourced variables first
    for (const ef of envFrom) {
      const prefix = ef.prefix || "";

      if (ef.configMapRef) {
        const cmData = configMapCache[ef.configMapRef];
        if (cmData) {
          for (const [key, value] of Object.entries(cmData)) {
            result.push({
              name: `${prefix}${key}`,
              value,
              sourceType: "envFromConfigMap",
              sourceName: ef.configMapRef,
              sourceKey: key,
              isFromEnvFrom: true,
            });
          }
        } else if (!loadingConfigMaps) {
          // Show placeholder when data not loaded yet
          result.push({
            name: `${prefix}*`,
            value: null,
            sourceType: "envFromConfigMap",
            sourceName: ef.configMapRef,
            isFromEnvFrom: true,
          });
        }
      }

      if (ef.secretRef) {
        const secretData = secretCache[ef.secretRef];
        if (secretData && showSecrets) {
          for (const [key, value] of Object.entries(secretData)) {
            result.push({
              name: `${prefix}${key}`,
              value,
              sourceType: "envFromSecret",
              sourceName: ef.secretRef,
              sourceKey: key,
              isFromEnvFrom: true,
            });
          }
        } else {
          // Show placeholder when secrets not revealed or not loaded
          result.push({
            name: `${prefix}*`,
            value: null,
            sourceType: "envFromSecret",
            sourceName: ef.secretRef,
            isFromEnvFrom: true,
          });
        }
      }
    }

    // Add regular env vars
    for (const envVar of env) {
      if (envVar.valueFrom) {
        result.push({
          name: envVar.name,
          value: envVar.value,
          sourceType: mapSourceType(envVar.valueFrom.sourceType),
          sourceName: envVar.valueFrom.name || undefined,
          sourceKey: envVar.valueFrom.key || undefined,
          fieldPath: envVar.valueFrom.fieldPath || undefined,
          resource: envVar.valueFrom.resource || undefined,
        });
      } else {
        result.push({
          name: envVar.name,
          value: envVar.value,
          sourceType: "direct",
        });
      }
    }

    return result;
  }, [
    env,
    envFrom,
    configMapCache,
    secretCache,
    showSecrets,
    loadingConfigMaps,
  ]);

  // Filter expanded env vars based on selected filter
  const filteredEnvVars = useMemo(() => {
    if (filter === "all") return expandedEnvVars;

    return expandedEnvVars.filter((ev) => {
      switch (filter) {
        case "direct":
          return ev.sourceType === "direct";
        case "secret":
          return ev.sourceType === "secret";
        case "configmap":
          return ev.sourceType === "configmap";
        case "field":
          return ev.sourceType === "field";
        case "resource":
          return ev.sourceType === "resource";
        case "envFrom":
          return (
            ev.sourceType === "envFromSecret" ||
            ev.sourceType === "envFromConfigMap"
          );
        default:
          return true;
      }
    });
  }, [expandedEnvVars, filter]);

  // Get the value to display for an env var
  const getDisplayValue = (ev: ExpandedEnvVar): string => {
    const isSecret =
      ev.sourceType === "secret" || ev.sourceType === "envFromSecret";
    const isRevealed = revealedSecrets.has(ev.name);

    // For envFrom placeholders
    if (ev.isFromEnvFrom && ev.name.endsWith("*")) {
      if (isSecret && !showSecrets) {
        return "(enable 'Show all secrets' to reveal)";
      }
      if (loadingConfigMaps || loadingSecrets) {
        return "Loading...";
      }
      return "(no data found)";
    }

    // For secrets from envFrom
    if (ev.sourceType === "envFromSecret") {
      if (!isRevealed) return ""; // MaskedValue will handle placeholder
      return ev.value || "";
    }

    // For secrets from secretKeyRef
    if (ev.sourceType === "secret") {
      if (!isRevealed) return ""; // MaskedValue will handle placeholder
      if (ev.sourceName && ev.sourceKey) {
        const secretData = secretCache[ev.sourceName];
        if (secretData && ev.sourceKey in secretData) {
          return secretData[ev.sourceKey];
        }
        if (loadingSecrets) return "Loading...";
        return `(not found: ${ev.sourceName}:${ev.sourceKey})`;
      }
      return ev.value || "";
    }

    // For configmap refs
    if (ev.sourceType === "configmap" || ev.sourceType === "envFromConfigMap") {
      if (ev.sourceName && ev.sourceKey) {
        const cmData = configMapCache[ev.sourceName];
        if (cmData && ev.sourceKey in cmData) {
          return cmData[ev.sourceKey];
        }
        if (loadingConfigMaps) return "Loading...";
        return `(not found: ${ev.sourceName}:${ev.sourceKey})`;
      }
      return ev.value || "";
    }

    // For field and resource refs
    if (ev.fieldPath) return ev.fieldPath;
    if (ev.resource) return ev.resource;

    // Direct value
    return ev.value || "-";
  };

  const toggleReveal = (name: string) => {
    setRevealedSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  // Get all secret env var names for bulk reveal
  const allSecretEnvNames = useMemo(() => {
    return expandedEnvVars
      .filter(
        (ev) => ev.sourceType === "secret" || ev.sourceType === "envFromSecret"
      )
      .filter((ev) => !ev.name.endsWith("*")) // Exclude placeholders
      .map((ev) => ev.name);
  }, [expandedEnvVars]);

  return (
    <Collapsible asChild open={isExpanded} onOpenChange={setIsExpanded}>
      <Section>
        <SectionHeader
          title="Environment Variables"
          count={
            hasEnvVars
              ? expandedEnvVars.filter((ev) => !ev.name.endsWith("*")).length
              : undefined
          }
          actions={
            <>
              <Select
                value={filter}
                onValueChange={(value) => setFilter(value as FilterOption)}
              >
                <SelectTrigger className="w-[140px] h-8">
                  <SelectValue placeholder="Filter by source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Sources</SelectItem>
                  <SelectItem value="direct">Direct</SelectItem>
                  <SelectItem value="secret">Secret</SelectItem>
                  <SelectItem value="configmap">ConfigMap</SelectItem>
                  <SelectItem value="field">Field Ref</SelectItem>
                  <SelectItem value="resource">Resource Ref</SelectItem>
                  <SelectItem value="envFrom">EnvFrom</SelectItem>
                </SelectContent>
              </Select>

              {hasSecrets && (
                <div className="flex items-center gap-2 ml-2">
                  {loadingSecrets && (
                    <Loader2 className="h-4 w-4 animate-spin text-fg-mut" />
                  )}
                  <Switch
                    id={`show-secrets-${containerName}`}
                    checked={showSecrets}
                    onCheckedChange={(checked) => {
                      setShowSecrets(checked);
                      // When enabling, reveal all secrets; when disabling, hide all
                      if (checked) {
                        setRevealedSecrets(new Set(allSecretEnvNames));
                      } else {
                        setRevealedSecrets(new Set());
                      }
                    }}
                    disabled={loadingSecrets}
                  />
                  <Label
                    htmlFor={`show-secrets-${containerName}`}
                    className="text-[11px] text-fg-mut"
                  >
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
          {!hasEnvVars ? (
            <p className="text-xs text-fg-fnt">
              No environment variables defined
            </p>
          ) : filteredEnvVars.length === 0 ? (
            <p className="text-xs text-fg-fnt">
              No environment variables match the selected filter
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[200px]">Name</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead className="w-[200px]">Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredEnvVars.map((ev) => {
                  const isSecret =
                    ev.sourceType === "secret" ||
                    ev.sourceType === "envFromSecret";
                  const isRevealed = revealedSecrets.has(ev.name);
                  const displayValue = getDisplayValue(ev);
                  const isPlaceholder = ev.name.endsWith("*");

                  return (
                    <TableRow
                      key={`${ev.sourceType}-${ev.sourceName || ""}-${ev.name}`}
                    >
                      <TableCell className="font-mono text-xs font-medium">
                        {isPlaceholder ? (
                          <span className="text-fg-fnt">
                            (all keys from {ev.sourceName})
                          </span>
                        ) : (
                          ev.name
                        )}
                      </TableCell>
                      <TableCell>
                        {isPlaceholder ? (
                          <span className="text-xs text-fg-fnt">
                            {displayValue}
                          </span>
                        ) : isSecret ? (
                          <MaskedValue
                            value={displayValue}
                            isRevealed={isRevealed}
                            onToggleReveal={() => toggleReveal(ev.name)}
                            isLoading={loadingSecrets}
                            showCopy={isRevealed}
                            compact
                          />
                        ) : (
                          <span className="font-mono text-xs break-all">
                            {displayValue}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <SourceCell
                          type={ev.sourceType}
                          name={ev.sourceName}
                          namespace={namespace}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CollapsibleContent>
      </Section>
    </Collapsible>
  );
}
