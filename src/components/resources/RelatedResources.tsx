/**
 * Related Resources Component
 *
 * Displays owner references as clickable links to parent resources.
 * Shows the chain of ownership for a Kubernetes resource.
 */

import { Link } from "react-router-dom";
import { Section, SectionHeader } from "@/components/ui/section";
import { Badge } from "@/components/ui/badge";
import { ResourceIcon } from "@/components/shared/ResourceIcon";
import { isResourceType } from "@/lib/resource-registry";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
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

  // Find controller owner (the primary owner)
  const controllerOwner = ownerReferences.find((ref) => ref.controller);
  const otherOwners = ownerReferences.filter((ref) => !ref.controller);

  return (
    <Section>
      <SectionHeader title="Related Resources" />
      <div className="flex flex-col gap-3">
        {controllerOwner && (
          <div className="flex flex-col gap-1">
            <div className="text-xs text-fg-mut font-medium">Controlled by</div>
            <OwnerLink owner={controllerOwner} namespace={namespace} />
          </div>
        )}

        {otherOwners.length > 0 && (
          <div className="flex flex-col gap-1">
            <div className="text-xs text-fg-mut font-medium">Other owners</div>
            <div className="flex flex-col gap-2">
              {otherOwners.map((owner) => (
                <OwnerLink
                  key={owner.uid}
                  owner={owner}
                  namespace={namespace}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}

interface OwnerLinkProps {
  owner: OwnerReference;
  namespace?: string;
}

function OwnerLink({ owner, namespace }: OwnerLinkProps) {
  const isSupported = isResourceType(owner.kind);

  const content = (
    <div
      className={`flex items-center gap-2 rounded border border-hair p-2 text-sm ${isSupported ? "hover:bg-hover cursor-pointer" : ""} transition-colors`}
    >
      <ResourceIcon kind={owner.kind} className="h-4 w-4 text-fg-mut" />
      <span className="font-medium">{owner.name}</span>
      <Badge variant="outline" className="ml-auto text-xs">
        {owner.kind}
      </Badge>
    </div>
  );

  // Only make it a link if we have a route for this resource type
  if (isSupported) {
    const path = getResourceDetailUrl(owner.kind, owner.name, namespace);
    return (
      <Link to={path} className="block">
        {content}
      </Link>
    );
  }

  // Otherwise just show the info without navigation
  return <div className="block">{content}</div>;
}
