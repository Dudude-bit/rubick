import { Section, SectionHeader } from "@/components/ui/section";
import { groupMounts, mountedBy } from "@/lib/mounts";
import { ResourceRef } from "./ResourceRef";
import type { PodVolumeInfo } from "@/generated/types";

/**
 * What a pod mounts, and what each mount is made of.
 *
 * A pod names every ConfigMap, Secret and claim it depends on in
 * `.spec.volumes`, and none of it reached a screen: the only way to find out
 * which ConfigMap `cfg` was, or which claim the data directory came from, was
 * to open the YAML tab and read the spec by hand.
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
  if (volumes.length === 0) {
    return (
      <Section>
        <SectionHeader title="Volumes" />
        <p className="py-1 text-xs text-fg-fnt">
          This pod mounts nothing of its own.
        </p>
      </Section>
    );
  }

  return (
    <Section>
      <SectionHeader title="Volumes" count={volumes.length} />
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
 * neither the path's typeface nor its weight. That last part is the point of
 * the rewrite — `ro` sat inside the run of path text and read as part of it,
 * and a subPath joined to the path with a slash was indistinguishable from a
 * longer path, which is not what it is: it is a path inside the volume.
 * `read-only` is the word the Connections tab already uses for the same flag.
 *
 * Container identity colour (`--ctr-*`) is deliberately not used. It means
 * something in the log gutter because a legend there says which container is
 * which; in a three-column table with no legend it would be a second tinted
 * channel competing with the reference links the middle column carries and
 * with `--warn` on the row below.
 */
function Mounts({
  volume,
  containerCount,
}: {
  volume: PodVolumeInfo;
  containerCount: number;
}) {
  if (volume.mounts.length === 0) {
    // Declared and read by no container. The YAML does not point at it and
    // nothing fails, so the pod runs without the config somebody added.
    return <span className="text-[11px] text-warn">mounted by nothing</span>;
  }
  return (
    <span className="min-w-0 wrap-break-word text-[11px] text-fg-fnt">
      {groupMounts(volume.mounts).map(({ key, mount, containers }) => {
        const who = mountedBy(containers, containerCount);
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
                {" from "}
                <span className="font-mono text-fg-mut">{mount.subPath}</span>
              </>
            )}
            {mount.readOnly && ", read-only"}
          </span>
        );
      })}
    </span>
  );
}
