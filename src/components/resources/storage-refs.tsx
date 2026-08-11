import { ResourceType } from "@/lib/resource-registry";
import { ResourceRef } from "./ResourceRef";

/**
 * The objects a volume and a claim name each other and their class by.
 *
 * Both detail pages already rendered these as references; only the lists were
 * printing them as bare mono text, so the same fact carried a kind glyph and
 * an identity tint on one screen and neither on the next.
 */

/** `spec.claimRef` arrives serialised as `namespace/name`. */
function splitClaim(claim: string): {
  namespace?: string;
  name: string;
} {
  const slash = claim.indexOf("/");
  if (slash === -1) return { name: claim };
  return { namespace: claim.slice(0, slash), name: claim.slice(slash + 1) };
}

export function ClaimRef({ claim }: { claim?: string | null }) {
  if (!claim) return <span className="text-fg-fnt">\u2014</span>;
  const { namespace, name } = splitClaim(claim);
  return (
    <ResourceRef
      kind={ResourceType.PersistentVolumeClaim}
      name={name}
      namespace={namespace}
      showKind={false}
    />
  );
}

export function StorageClassRef({
  name,
  fallback = "\u2014",
}: {
  name?: string | null;
  /** A claim with no class gets the cluster default, which is not "none". */
  fallback?: string;
}) {
  if (!name) return <span className="text-fg-fnt">{fallback}</span>;
  return (
    <ResourceRef
      kind={ResourceType.StorageClass}
      name={name}
      showKind={false}
    />
  );
}
