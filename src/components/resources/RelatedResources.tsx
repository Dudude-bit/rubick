/**
 * Who owns this object.
 *
 * An owner reference is one fact — "a DaemonSet made this pod" — so it reads
 * as a metadata row like every other fact on the page. It used to be a
 * bordered, hoverable box with the kind floated right in a pill, which made
 * the least surprising thing on a pod page the only elevated one.
 */

import { Section, SectionHeader } from "@/components/ui/section";
import { isResourceType } from "@/lib/resource-registry";
import { ResourceLink } from "./detail-blocks";
import { KeyValueRow } from "./detail-kv";
import type { OwnerReference } from "@/generated/types";

interface RelatedResourcesProps {
  ownerReferences: OwnerReference[];
  namespace?: string;
}

export function RelatedResources({
  ownerReferences,
  namespace,
}: RelatedResourcesProps) {
  if (!ownerReferences || ownerReferences.length === 0) {
    return null;
  }

  const controller = ownerReferences.find((ref) => ref.controller);
  const others = ownerReferences.filter((ref) => !ref.controller);

  return (
    <Section>
      <SectionHeader title="Related resources" />
      <dl className="flex flex-col">
        {controller && (
          <OwnerRow
            label="Controlled by"
            owner={controller}
            namespace={namespace}
          />
        )}
        {others.map((owner) => (
          <OwnerRow
            key={owner.uid}
            label="Owner"
            owner={owner}
            namespace={namespace}
          />
        ))}
      </dl>
    </Section>
  );
}

function OwnerRow({
  label,
  owner,
  namespace,
}: {
  label: string;
  owner: OwnerReference;
  namespace?: string;
}) {
  return (
    <KeyValueRow label={label}>
      <span className="flex flex-wrap items-baseline gap-x-2">
        {isResourceType(owner.kind) ? (
          <ResourceLink
            kind={owner.kind}
            name={owner.name}
            namespace={namespace}
          />
        ) : (
          <span className="font-mono">{owner.name}</span>
        )}
        {/* The kind qualifies the name. It is not a state, so it is quiet
         *  text rather than a badge. */}
        <span className="text-[11px] text-fg-fnt">{owner.kind}</span>
      </span>
    </KeyValueRow>
  );
}
