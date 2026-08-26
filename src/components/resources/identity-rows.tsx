import type { T } from "@/i18n/useT";
import { ResourceRef } from "./ResourceRef";
import type { KeyValue } from "./key-values";

/**
 * The identity a pod, or every replica a template will make, holds against
 * the API server.
 *
 * One row, written once, because seven pages want the identical thing and a
 * seventh spelling of it is how the six drift. `ServiceAccount` has no route
 * — `isRoutableKind` rejects it and the reference degrades to the glyph and
 * the tinted name — which is deliberate: the kind is worth naming under the
 * same mark everywhere it appears, and the day it gets a page every one of
 * these lights up without an edit.
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
