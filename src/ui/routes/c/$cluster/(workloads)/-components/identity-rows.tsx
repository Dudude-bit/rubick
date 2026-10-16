import type { T } from "@/i18n/useT";
import { ResourceRef } from "@/components/object/ResourceRef";
import type { KeyValue } from "@/components/object/key-values";

/**
 * The identity a pod, or every replica a template will make, holds against
 * the API server. One row, written once, because seven pages want the
 * identical thing.
 */
export function serviceAccountRow(
  name: string | null | undefined,
  namespace: string | null | undefined,
  t: T
): KeyValue {
  return {
    label: t("columns", "serviceAccount"),
    value: name ? (
      <ResourceRef
        kind="ServiceAccount"
        name={name}
        namespace={namespace}
        showKind={false}
      />
    ) : (
      // The API server fills this in when the spec omits it, so the pod runs
      // as something either way and "none" would be a lie.
      "default"
    ),
  };
}
