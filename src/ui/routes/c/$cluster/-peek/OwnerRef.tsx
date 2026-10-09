import { ResourceRef } from "@/components/object/ResourceRef";
import { groupOf, useCrdIndex } from "@/hooks/useCrdIndex";
import { crdInGroup } from "@/lib/links";

/** Either owner-reference shape: the generated one spells `api_version`. */
export type Owner = { kind: string; name: string } & (
  | { apiVersion: string }
  | { api_version: string }
);

const apiVersionOf = (owner: Owner) =>
  "apiVersion" in owner ? owner.apiVersion : owner.api_version;

/** An owner opens by its group: a namesake of a built-in kind opens its CRD. */
export function OwnerRef({
  owner,
  namespace,
}: {
  owner: Owner;
  namespace: string | null;
}) {
  const { crdFor } = useCrdIndex();
  return (
    <ResourceRef
      kind={owner.kind}
      name={owner.name}
      namespace={namespace}
      crd={crdInGroup(
        { kind: owner.kind, group: groupOf(apiVersionOf(owner)) },
        crdFor
      )}
      showKind={false}
    />
  );
}
