/**
 * A namespace, read for what other objects ask of it: its labels — exactly
 * what a Gateway listener's allowedRoutes selector and every
 * namespaceSelector match against — and whether it is Active or stuck
 * Terminating. Deliberately no Delete here: a namespace takes everything
 * in it along, and this page exists to be glanced at from a peek.
 */

import { Info } from "lucide-react";

import { yamlTab } from "@/components/resources/yaml-tab";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import { viewGlyph } from "@/components/resources/detail-tab";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { useResourceDetail } from "@/hooks";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import type { NamespaceInfo } from "@/generated/types";

export function NamespaceDetail() {
  const {
    name,
    resource: ns,
    isLoading,
    error,
    yaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
    freshness,
  } = useResourceDetail<NamespaceInfo>({
    resourceKind: ResourceType.Namespace,
    isClusterScoped: true,
    fetchResource: (name) => commands.getNamespace(name),
    defaultTab: "overview",
  });

  const facts: KeyValue[] = [
    {
      label: "Status",
      value: ns?.status ?? "—",
      // Terminating is the state people come to diagnose — a namespace
      // wedged on a finalizer looks exactly like this, for days.
      tone: ns && ns.status !== "Active" ? ("warn" as const) : undefined,
    },
  ];

  const tabs = [
    {
      id: "overview",
      label: "Overview",
      glyph: viewGlyph(Info),
      content: (
        <>
          <KeyValueSection
            title="Namespace"
            items={facts}
            className="max-w-lg"
          />
          <KeyValueSection
            title="Labels"
            count={Object.keys(ns?.labels ?? {}).length}
            items={recordToKeyValues(ns?.labels ?? {})}
            emptyMessage="No labels — no namespaceSelector anywhere matches this namespace."
          />
        </>
      ),
    },
    yamlTab({
      title: "Namespace YAML",
      yaml,
      resourceKind: ResourceType.Namespace,
      resourceName: name || "",
      namespace: undefined,
      onCopy: copyYaml,
    }),
  ];

  return (
    <ResourceDetailLayout
      freshness={freshness}
      resource={ns}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.Namespace}
      title={ns?.name || name || ""}
      createdAt={ns?.createdAt}
      badges={
        ns &&
        ns.status !== "Active" && (
          <span className="text-[11px] font-medium text-warn">{ns.status}</span>
        )
      }
      onBack={goBack}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabs={tabs}
    />
  );
}
