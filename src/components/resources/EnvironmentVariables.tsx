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
import { ResourceRef } from "@/components/resources/ResourceRef";
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

/** Which filter option a row answers to. One mapping, so the control
 *  offering an option and the list honouring it cannot drift. */
function filterOf(sourceType: SourceType): FilterOption {
  return sourceType === "envFromSecret" || sourceType === "envFromConfigMap"
    ? "envFrom"
    : sourceType;
}

/** The picker names a source with the same word its rows do. */
const FILTER_LABEL: Record<FilterOption, string> = {
  all: "all sources",
  direct: SOURCE_LABEL.direct,
  secret: SOURCE_LABEL.secret,
  configmap: SOURCE_LABEL.configmap,
  field: SOURCE_LABEL.field,
  resource: SOURCE_LABEL.resource,
  envFrom: "envFrom",
};

const FILTER_ORDER = [
  "direct",
  "secret",
  "configmap",
  "field",
  "resource",
  "envFrom",
] as const satisfies readonly FilterOption[];

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
          <ResourceRef
            kind={isSecret ? ResourceType.Secret : ResourceType.ConfigMap}
            name={name}
            namespace={namespace}
            showKind={false}
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

  // Per-name parallel queries via useQueries. A referenced ConfigMap or
  // Secret may not be readable with the current access, so a failure is
  // swallowed into `?? {}` rather than surfaced — the env row still renders,
  // just without the resolved value.
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

  const filteredEnvVars = useMemo(
    () =>
      filter === "all"
        ? expandedEnvVars
        : expandedEnvVars.filter((ev) => filterOf(ev.sourceType) === filter),
    [expandedEnvVars, filter]
  );

  /**
   * The sources actually present. A picker offering six of them over a
   * container whose variables all came from one place is a control whose
   * every setting but the current one empties the list.
   */
  const sources = useMemo(() => {
    const present = new Set<FilterOption>();
    for (const ev of expandedEnvVars) present.add(filterOf(ev.sourceType));
    return present;
  }, [expandedEnvVars]);

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

  // Chrome after content, never before it. A container that declares no
  // variables was still getting a heading, a bordered source picker and a
  // chevron — three controls over an empty list, on four of the five
  // containers of an ordinary pod. What is true is one line long.
  if (!hasEnvVars) {
    return (
      <p className="text-xs text-fg-fnt">No environment variables declared</p>
    );
  }

  return (
    <Collapsible asChild open={isExpanded} onOpenChange={setIsExpanded}>
      <Section>
        <SectionHeader
          title="Environment"
          count={expandedEnvVars.filter((ev) => !ev.name.endsWith("*")).length}
          actions={
            <>
              {sources.size > 1 && (
                <Select
                  value={filter}
                  onValueChange={(value) => setFilter(value as FilterOption)}
                >
                  {/* Borderless, like every other picker on a detail page:
                      the canvas has no boxed controls. */}
                  <SelectTrigger
                    aria-label="Filter by source"
                    className="h-6 w-auto gap-1 border-0 bg-transparent px-1.5 text-[11px] text-fg-mut hover:bg-hover focus:ring-0 focus:ring-offset-0"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{FILTER_LABEL.all}</SelectItem>
                    {FILTER_ORDER.filter((option) => sources.has(option)).map(
                      (option) => (
                        <SelectItem key={option} value={option}>
                          {FILTER_LABEL[option]}
                        </SelectItem>
                      )
                    )}
                  </SelectContent>
                </Select>
              )}

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
          {filteredEnvVars.length === 0 ? (
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
