import { useState, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import type { ConfigData } from "@/generated/types";
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
import { T } from "@/i18n/T";
import { useT } from "@/i18n/useT";

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

/** What each source is called, as catalogue keys: read at import. */
const SOURCE_LABEL = {
  direct: "envInline",
  secret: "envSecret",
  configmap: "envConfigMap",
  field: "envFieldRef",
  resource: "envResourceRef",
  envFromSecret: "envFromSecret",
  envFromConfigMap: "envFromConfigMap",
} as const satisfies Record<SourceType, string>;

/** Which filter option a row answers to. One mapping, so the control
 *  offering an option and the list honouring it cannot drift. */
function filterOf(sourceType: SourceType): FilterOption {
  return sourceType === "envFromSecret" || sourceType === "envFromConfigMap"
    ? "envFrom"
    : sourceType;
}

/** The picker names a source with the same word its rows do. */
const FILTER_LABEL = {
  all: "envAllSources",
  direct: SOURCE_LABEL.direct,
  secret: SOURCE_LABEL.secret,
  configmap: SOURCE_LABEL.configmap,
  field: SOURCE_LABEL.field,
  resource: SOURCE_LABEL.resource,
  envFrom: "envFromWord",
} as const satisfies Record<FilterOption, string>;

const FILTER_ORDER = [
  "direct",
  "secret",
  "configmap",
  "field",
  "resource",
  "envFrom",
] as const satisfies readonly FilterOption[];

/**
 * Which object a variable was drawn from, and which entry of it.
 *
 * The key is printed beside the reference and is deliberately *not* part of
 * it: `database.url` inside a ConfigMap is not an object and has no URL, so
 * making it look like one would promise a destination that cannot exist. The
 * reference goes to the ConfigMap — which is the page where that key and its
 * value are on screen — and the key says which line to read when you get
 * there.
 */
function SourceCell({
  type,
  name,
  sourceKey,
  namespace,
}: {
  type: SourceType;
  name?: string;
  sourceKey?: string;
  namespace?: string;
}) {
  const t = useT();
  const isSecret = type === "secret" || type === "envFromSecret";
  const isConfigMap = type === "configmap" || type === "envFromConfigMap";
  return (
    <span className="text-[11px] text-fg-fnt">
      {/* The word already says the kind, so the reference does not repeat
          it — `configmap app-config`, not `configmap ConfigMap/app-config`. */}
      {t("readings", SOURCE_LABEL[type])}
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
      {name && sourceKey && (
        <span className="font-mono text-fg-fnt"> → {sourceKey}</span>
      )}
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

/**
 * Resolved values by resource name — one entry per name that answered, empty
 * for one that refused. A name still in flight is absent, which is how the
 * rows tell "reading" from "not readable".
 */
function useDataCache(
  names: string[],
  queries: { data?: ConfigData; isError: boolean }[]
): DataCache {
  return useMemo(() => {
    const cache: DataCache = {};
    names.forEach((name, i) => {
      const q = queries[i];
      if (q?.data) cache[name] = q.data.values;
      else if (q?.isError) cache[name] = {};
    });
    return cache;
  }, [names, queries]);
}

// Filter options for source types
type FilterOption =
  "all" | "direct" | "secret" | "configmap" | "field" | "resource" | "envFrom";

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
  const t = useT();
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

  // Only the values the backend was willing to hand over, for both kinds. A
  // withheld or binary key stays out of the cache, so an env var reading one
  // is drawn as an env var whose value the app does not have rather than as
  // an empty one — or, for binary, as mojibake.
  const configMapCache = useDataCache(allConfigMapNames, configMapQueries);
  const secretCache = useDataCache(allSecretNames, secretQueries);

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
        return t("empty", "enableShowSecrets");
      }
      if (loadingConfigMaps || loadingSecrets) {
        return t("settings", "loading");
      }
      return t("empty", "noDataFound");
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
        if (loadingSecrets) return t("settings", "loading");
        return t("empty", "notFoundRef", {
          name: ev.sourceName,
          key: ev.sourceKey,
        });
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
        if (loadingConfigMaps) return t("settings", "loading");
        return t("empty", "notFoundRef", {
          name: ev.sourceName,
          key: ev.sourceKey,
        });
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
  // containers of an ordinary pod.
  //
  // Nothing at all, not a one-line denial: on `log-demo` that denial was the
  // same sentence printed five times down the tab, which is longer than the
  // fact it reports and reads as a fault rather than as an absence. Every
  // other optional row here — ports, limits, last exit — is simply missing
  // when it has no content, and a reader who wants the empty list has the
  // YAML tab.
  if (!hasEnvVars) return null;

  return (
    <Collapsible asChild open={isExpanded} onOpenChange={setIsExpanded}>
      <Section>
        <SectionHeader
          title={t("columns", "environment")}
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
                    aria-label={t("action", "filterBySource")}
                    className="h-6 w-auto gap-1 border-0 bg-transparent px-1.5 text-[11px] text-fg-mut hover:bg-hover focus:ring-0 focus:ring-offset-0"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">
                      {t("action", "allSources")}
                    </SelectItem>
                    {FILTER_ORDER.filter((option) => sources.has(option)).map(
                      (option) => (
                        <SelectItem key={option} value={option}>
                          {t("readings", FILTER_LABEL[option])}
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
                    {t("action", "showSecrets")}
                  </Label>
                </div>
              )}

              <CollapsibleTrigger
                aria-label={
                  isExpanded ? t("action", "collapse") : t("action", "expand")
                }
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
              <T section="empty" k="noEnvVarsMatchFilter" />
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[200px]">
                    {t("columns", "name")}
                  </TableHead>
                  <TableHead>{t("columns", "value")}</TableHead>
                  {/* Wide enough for `configmap demo-config → database.url` on one
                      line: the object and the key it points into are one fact,
                      and wrapping between them reads as two. */}
                  <TableHead className="w-[280px]">
                    {t("columns", "source")}
                  </TableHead>
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
                            {t("empty", "allKeysFrom")}{" "}
                            {ev.sourceName && namespace ? (
                              <ResourceRef
                                kind={
                                  isSecret
                                    ? ResourceType.Secret
                                    : ResourceType.ConfigMap
                                }
                                name={ev.sourceName}
                                namespace={namespace}
                                showKind={false}
                              />
                            ) : (
                              ev.sourceName
                            )}
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
                            label={ev.name}
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
                          // On an envFrom row the key *is* the variable's
                          // name, already the first column; repeating it
                          // here would print it twice on the same line.
                          sourceKey={
                            ev.isFromEnvFrom ? undefined : ev.sourceKey
                          }
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
