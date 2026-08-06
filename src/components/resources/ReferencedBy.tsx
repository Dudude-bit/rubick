/**
 * What consumes this Secret or ConfigMap.
 *
 * A reference is a kind, a name and how it is consumed, so it is one row —
 * not a collapsible group of bordered link tiles with a count badge on each.
 * Empty relationships are dropped instead of drawn as "No references found":
 * the reader is looking for what does use the object, and five empty groups
 * bury the one that is not.
 */

import { useQuery } from "@tanstack/react-query";

import { Section, SectionHeader } from "@/components/ui/section";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import { ResourceRef } from "./ResourceRef";
import type { ResourceReferences } from "@/generated/types";

interface ReferencedByProps {
  resourceType: "Secret" | "ConfigMap";
  name: string;
  namespace: string;
}

interface RefRow {
  kind: string;
  name: string;
  namespace: string;
  /** How the object is consumed: container, key, mount path, host. */
  via: string;
}

const REF_ROW =
  "grid grid-cols-[minmax(0,92px)_minmax(0,232px)_minmax(0,1fr)] items-baseline gap-2.5 border-b border-hair py-1 last:border-b-0 text-xs";

function join(...parts: (string | null | undefined | false)[]): string {
  return parts.filter(Boolean).join(" · ");
}

export function ReferencedBy({
  resourceType,
  name,
  namespace,
}: ReferencedByProps) {
  const { data, isLoading, error } = useQuery<ResourceReferences>({
    queryKey: ["resourceReferences", resourceType, name, namespace],
    queryFn: () =>
      commands.getResourceReferences(resourceType, name, namespace),
  });

  const refs = data ?? {
    envVars: [],
    envFrom: [],
    volumes: [],
    imagePullSecrets: [],
    tlsIngress: [],
  };

  const groups: { label: string; rows: RefRow[] }[] = [
    {
      label: "Environment variables",
      rows: refs.envVars.map((ref) => ({
        kind: ref.kind,
        name: ref.name,
        namespace: ref.namespace,
        via: join(ref.containerName, ref.key),
      })),
    },
    {
      label: "Bulk import (envFrom)",
      rows: refs.envFrom.map((ref) => ({
        kind: ref.kind,
        name: ref.name,
        namespace: ref.namespace,
        via: join(ref.containerName, "all keys"),
      })),
    },
    {
      label: "Volume mounts",
      rows: refs.volumes.map((ref) => ({
        kind: ref.kind,
        name: ref.name,
        namespace: ref.namespace,
        via: join(ref.containerName, ref.mountPath),
      })),
    },
    ...(resourceType === ResourceType.Secret
      ? [
          {
            label: "Image pull secrets",
            rows: refs.imagePullSecrets.map((ref) => ({
              kind: ref.kind,
              name: ref.name,
              namespace: ref.namespace,
              via: join(ref.containerName),
            })),
          },
          {
            label: "TLS ingress",
            rows: refs.tlsIngress.map((ref) => ({
              kind: ResourceType.Ingress,
              name: ref.name,
              namespace: ref.namespace,
              via: ref.hosts.join(", "),
            })),
          },
        ]
      : []),
  ].filter((group) => group.rows.length > 0);

  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);

  return (
    <Section>
      {/* "Referenced by" is not a noun a count can lean on, so the count
          brings its own. */}
      <SectionHeader
        title="Referenced by"
        count={
          isLoading || error || total === 0
            ? undefined
            : `${total} ${total === 1 ? "reference" : "references"}`
        }
      />
      {isLoading ? (
        <p className="text-xs text-fg-fnt">Reading references…</p>
      ) : error ? (
        <p className="text-xs text-err">
          Could not read references: {String(error)}
        </p>
      ) : total === 0 ? (
        <p className="text-xs text-fg-fnt">
          Nothing in this namespace references this{" "}
          {resourceType === ResourceType.Secret ? "Secret" : "ConfigMap"}
        </p>
      ) : (
        groups.map((group) => (
          <div key={group.label}>
            <div className="pb-0.5 pt-2 text-[11px] text-fg-fnt">
              {group.label}
              <span className="font-mono text-fg-mut">
                {" "}
                · {group.rows.length}
              </span>
            </div>
            {group.rows.map((row, index) => (
              <div key={`${row.kind}/${row.name}/${index}`} className={REF_ROW}>
                <span className="truncate text-fg-mut">{row.kind}</span>
                <span className="min-w-0 truncate">
                  <ResourceRef
                    kind={row.kind}
                    name={row.name}
                    namespace={row.namespace}
                    showKind={false}
                  />
                </span>
                <span
                  className="truncate text-[11px] text-fg-fnt"
                  title={row.via}
                >
                  {row.via || "—"}
                </span>
              </div>
            ))}
          </div>
        ))
      )}
    </Section>
  );
}
