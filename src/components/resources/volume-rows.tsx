import { Section, SectionHeader } from "@/components/ui/section";
import { cn } from "@/lib/utils";
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
}: {
  volumes: PodVolumeInfo[];
  namespace: string;
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
            <Mounts volume={volume} />
          </div>
        ))}
      </div>
    </Section>
  );
}

function Mounts({ volume }: { volume: PodVolumeInfo }) {
  if (volume.mounts.length === 0) {
    // Declared and read by no container. The YAML does not point at it and
    // nothing fails, so the pod runs without the config somebody added.
    return <span className="text-[11px] text-warn">mounted by nothing</span>;
  }
  return (
    <span className="min-w-0 truncate text-[11px] text-fg-fnt">
      {volume.mounts.map((mount, index) => (
        <span key={`${mount.container}${mount.path}`}>
          {index > 0 && " · "}
          <span className="text-fg-mut">{mount.container}</span>{" "}
          <span className={cn("font-mono", mount.readOnly && "text-fg-fnt")}>
            {mount.path}
          </span>
          {mount.subPath && <span className="font-mono">/{mount.subPath}</span>}
          {mount.readOnly && " ro"}
        </span>
      ))}
    </span>
  );
}
