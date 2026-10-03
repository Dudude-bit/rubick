import { Section, SectionHeader } from "@/components/ui/section";
import { groupMounts, mountedBy } from "@/lib/mounts";
import { ResourceRef } from "./ResourceRef";
import type { PodVolumeInfo } from "@/generated/types";
import { T } from "@/i18n/T";
import { useT } from "@/i18n/useT";

/**
 * What a pod mounts, and what each mount is made of — every ConfigMap, Secret
 * and claim the pod names in `.spec.volumes`.
 *
 * Three columns, because a volume answers three questions and they are
 * different questions: what the pod calls it, what it actually is, and who
 * reads it. The middle column carries the reference and nothing else does —
 * a row where the name, the source and every mount path were all tinted
 * would be four links to two places.
 */

const VOLUME_ROW =
  "grid grid-cols-[minmax(0,150px)_minmax(0,244px)_minmax(0,1fr)] items-baseline gap-2.5 border-b border-hair py-1 last:border-b-0 text-xs";

export function VolumeRows({
  volumes,
  namespace,
  containerCount,
}: {
  volumes: PodVolumeInfo[];
  namespace: string;
  /** Every container the pod declares, init containers included — what
   *  lets the third column say "all containers" and mean it. */
  containerCount: number;
}) {
  const t = useT();
  if (volumes.length === 0) {
    return (
      <Section>
        <SectionHeader title={t("nav", "volumes")} />
        <p className="py-1 text-xs text-fg-fnt">
          <T section="empty" k="podMountsNothing" />
        </p>
      </Section>
    );
  }

  return (
    <Section>
      <SectionHeader title={t("nav", "volumes")} count={volumes.length} />
      <div>
        {volumes.map((volume) => (
          <div key={volume.name} className={VOLUME_ROW}>
            {/* The pod's own word for the volume. It is a name inside this
                spec and nothing else — there is no ServiceAccount-style
                object behind it — so it stays plain mono. */}
            <span
              className="truncate font-mono text-fg-mid"
              title={volume.name}
            >
              {volume.name}
            </span>
            <span className="min-w-0 truncate">
              {/* The source word already says the kind, so the reference
                  does not repeat it: `configMap app-config`, not
                  `configMap ConfigMap/app-config`. */}
              <span className="text-[11px] text-fg-fnt">{volume.source}</span>
              {volume.refs.map((ref) => (
                <span key={`${ref.kind}/${ref.name}`}>
                  {" "}
                  <ResourceRef
                    kind={ref.kind}
                    name={ref.name}
                    namespace={namespace}
                    showKind={false}
                  />
                </span>
              ))}
            </span>
            <Mounts volume={volume} containerCount={containerCount} />
          </div>
        ))}
      </div>
    </Section>
  );
}

/**
 * Where the volume is mounted — one line per distinct mount, not per
 * container.
 *
 * `ingest, web · /etc/app from app.conf, read-only`. Three kinds of thing in
 * three tones: who mounts it, the literal path in mono, and the qualifiers in
 * neither the path's typeface nor its weight — a subPath is a path *inside*
 * the volume, not a continuation of the path, and `read-only` is the word the
 * Connections tab already uses for the same flag.
 *
 * Container identity colour (`--ctr-*`) is deliberately not used: it means
 * something in the log gutter, where a legend says which container is which,
 * and here it would be a second tinted channel competing with the reference
 * links the middle column carries and with `--warn` on the row below.
 */
function Mounts({
  volume,
  containerCount,
}: {
  volume: PodVolumeInfo;
  containerCount: number;
}) {
  const t = useT();
  if (volume.mounts.length === 0) {
    // Declared and read by no container. The YAML does not point at it and
    // nothing fails, so the pod runs without the config somebody added.
    return (
      <span className="text-[11px] text-warn">
        {t("empty", "mountedByNothing")}
      </span>
    );
  }
  return (
    <span className="min-w-0 wrap-break-word text-[11px] text-fg-fnt">
      {groupMounts(volume.mounts).map(({ key, mount, containers }) => {
        const who = mountedBy(containers, t, containerCount);
        return (
          <span key={key} className="block">
            {who && (
              <>
                <span className="text-fg-mut">{who}</span>
                {" · "}
              </>
            )}
            <span className="font-mono text-fg-mid">{mount.path}</span>
            {mount.subPath && (
              <>
                {` ${t("empty", "mountFrom")} `}
                <span className="font-mono text-fg-mut">{mount.subPath}</span>
              </>
            )}
            {mount.readOnly && `, ${t("empty", "readOnly")}`}
          </span>
        );
      })}
    </span>
  );
}
