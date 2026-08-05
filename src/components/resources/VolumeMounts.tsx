/**
 * A pod's volume mounts, as rows on the canvas.
 *
 * A mount is three facts — the path inside the container, what backs it, and
 * which container asked for it — so it is one hairline-separated row rather
 * than a bordered card with badges. Secret and ConfigMap backings expand in
 * place, and the expansion is the same key/value block the ConfigMap and
 * Secret pages are built from instead of a second, private rendering of the
 * same data.
 */

import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { commands } from "@/lib/commands";
import { cn } from "@/lib/utils";
import { DataSection } from "./data-rows";
import { ResourceLink } from "./detail-blocks";
import type { VolumeReference } from "@/generated/types";

interface VolumeMountsProps {
  volumes: VolumeReference[];
  /** Required to read the backing Secret or ConfigMap. */
  namespace?: string;
}

type VolumeType =
  | "Secret"
  | "ConfigMap"
  | "PersistentVolumeClaim"
  | "EmptyDir"
  | "Other";

const KIND_TO_TYPE: Record<string, VolumeType> = {
  secret: "Secret",
  configmap: "ConfigMap",
  persistentvolumeclaim: "PersistentVolumeClaim",
  pvc: "PersistentVolumeClaim",
  emptydir: "EmptyDir",
};

/** What backs the mount, in the word the API uses for it. */
const SOURCE_LABEL: Record<VolumeType, string> = {
  Secret: "secret",
  ConfigMap: "configmap",
  PersistentVolumeClaim: "claim",
  EmptyDir: "emptyDir",
  Other: "volume",
};

function getVolumeType(kind: string): VolumeType {
  return KIND_TO_TYPE[kind.toLowerCase()] ?? "Other";
}

// The path column is capped rather than elastic: on a wide window a `1fr`
// path pushes the source and the container to the far edge, and the three
// facts of one mount stop reading as one row.
const MOUNT_ROW =
  "grid grid-cols-[minmax(0,380px)_minmax(0,280px)_minmax(0,1fr)] items-baseline gap-3 text-xs";

interface MountRowProps {
  volume: VolumeReference;
  type: VolumeType;
  open: boolean;
  onToggle: () => void;
  data?: Record<string, string>;
  loading?: boolean;
}

function MountRow({
  volume,
  type,
  open,
  onToggle,
  data,
  loading,
}: MountRowProps) {
  const expandable = type === "Secret" || type === "ConfigMap";
  const linkable = expandable || type === "PersistentVolumeClaim";
  const label =
    type === "Other" ? volume.kind.toLowerCase() : SOURCE_LABEL[type];
  const scope = [
    volume.containerName,
    volume.subPath && `subPath ${volume.subPath}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="border-b border-hair py-1 last:border-b-0">
      <div className={MOUNT_ROW}>
        {expandable ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="-mx-1 flex min-w-0 items-center gap-1 rounded px-1 text-left hover:bg-hover"
          >
            <ChevronRight
              className={cn(
                "h-3 w-3 shrink-0 text-fg-fnt transition-transform",
                open && "rotate-90"
              )}
            />
            <span className="truncate font-mono text-fg">
              {volume.mountPath}
            </span>
          </button>
        ) : (
          // Matches the chevron's 12px + 4px gap so every path starts on the
          // same column whether or not the row can be opened.
          <span className="block truncate pl-4 font-mono text-fg">
            {volume.mountPath}
          </span>
        )}
        <span className="min-w-0 truncate">
          <span className="text-fg-fnt">{label} </span>
          {linkable ? (
            <ResourceLink
              kind={volume.kind}
              name={volume.name}
              namespace={volume.namespace}
            />
          ) : (
            <span className="font-mono text-fg-mid">{volume.name}</span>
          )}
        </span>
        <span
          className="truncate text-[11px] text-fg-fnt"
          title={scope || undefined}
        >
          {scope || "—"}
        </span>
      </div>
      {open && (
        <div className="ml-4 mt-1.5 border-l border-hair pl-3">
          <DataSection
            data={data ?? {}}
            sensitive={type === "Secret"}
            isLoading={!!loading}
            emptyMessage={`This ${SOURCE_LABEL[type]} holds no keys`}
          />
        </div>
      )}
    </div>
  );
}

export function VolumeMounts({ volumes, namespace }: VolumeMountsProps) {
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(new Set());

  const rows = useMemo(
    () =>
      volumes.map((volume) => ({
        volume,
        type: getVolumeType(volume.kind),
        key: `${volume.name}/${volume.mountPath}`,
      })),
    [volumes]
  );

  const secretNames = useMemo(
    () => [
      ...new Set(
        rows.filter((r) => r.type === "Secret").map((r) => r.volume.name)
      ),
    ],
    [rows]
  );
  const configMapNames = useMemo(
    () => [
      ...new Set(
        rows.filter((r) => r.type === "ConfigMap").map((r) => r.volume.name)
      ),
    ],
    [rows]
  );

  const openSources = useMemo(
    () =>
      new Set(
        rows.filter((r) => openRows.has(r.key)).map((r) => r.volume.name)
      ),
    [rows, openRows]
  );

  // Reading a backing object is deferred until its row is opened: a pod can
  // mount a dozen ConfigMaps, and reading a Secret is a privileged call worth
  // not making until someone asks for it. `staleTime: Infinity` keeps a mount
  // that is opened and closed repeatedly to one read; `retry: false` plus the
  // undefined data leaves a forbidden read showing "no keys" rather than a
  // toast storm.
  const configMapQueries = useQueries({
    queries: configMapNames.map((name) => ({
      queryKey: ["configmap-data", namespace, name] as const,
      queryFn: () => commands.getConfigmapData(name, namespace!),
      enabled: !!namespace && openSources.has(name),
      staleTime: Infinity,
      retry: false,
    })),
  });

  const secretQueries = useQueries({
    queries: secretNames.map((name) => ({
      queryKey: ["secret-data", namespace, name] as const,
      queryFn: () => commands.getSecretData(name, namespace!),
      enabled: !!namespace && openSources.has(name),
      staleTime: Infinity,
      retry: false,
    })),
  });

  const toggle = (key: string) =>
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <Section>
      <SectionHeader
        title="Volume mounts"
        count={volumes.length > 0 ? volumes.length : undefined}
      />
      {volumes.length === 0 ? (
        <p className="text-xs text-fg-fnt">No volumes mounted</p>
      ) : (
        <div>
          {rows.map(({ volume, type, key }) => {
            const query =
              type === "Secret"
                ? secretQueries[secretNames.indexOf(volume.name)]
                : type === "ConfigMap"
                  ? configMapQueries[configMapNames.indexOf(volume.name)]
                  : undefined;
            return (
              <MountRow
                key={key}
                volume={volume}
                type={type}
                open={openRows.has(key)}
                onToggle={() => toggle(key)}
                data={query?.data}
                loading={query?.isFetching}
              />
            );
          })}
        </div>
      )}
    </Section>
  );
}
