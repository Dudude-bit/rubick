/**
 * Which namespaces this window is looking at.
 *
 * The store holds the selection; this is how a surface reads it. Nearly every
 * list in the app gets it for free through `ResourceList`, and the handful
 * that do not go through it narrow their own answers with
 * {@link NamespaceScope.narrow}.
 *
 * `narrow` is the identity for a scope of one or of none, and deliberately
 * so: those two cases are already scoped by the request itself, and filtering
 * a list the API server has already narrowed would only be a second chance to
 * get it wrong. A surface that asks per namespace instead — the overview, the
 * events feed — has nothing left to narrow either, and uses {@link scope} to
 * know what to ask for.
 */

import { useT } from "@/i18n/useT";
import { useMemo } from "react";

import { inScope, scopeIn, scopeLabel } from "@/lib/namespace-scope";
import { useClusterStore } from "@/stores/clusterStore";

export interface NamespaceScope {
  /** The selection. Empty is the whole cluster. */
  scope: string[];
  /** Whether the whole cluster is in view. */
  isAll: boolean;
  /** Whether the answer arrives cluster-wide and is narrowed on this side. */
  several: boolean;
  /** "All namespaces", "prod", "prod, staging", "4 namespaces". */
  label: string;
  /** The same thing inside a sentence: "no events in …". */
  inWords: string;
  matches: (namespace: string | null | undefined) => boolean;
  narrow: <T extends { namespace?: string | null }>(items: T[]) => T[];
}

export function useNamespaceScope(): NamespaceScope {
  const t = useT();
  const scope = useClusterStore((state) => state.namespaceScope);

  return useMemo(() => {
    const several = scope.length > 1;
    return {
      scope,
      isAll: scope.length === 0,
      several,
      label: scopeLabel(scope, t),
      inWords: scopeIn(scope, t),
      matches: (namespace) => inScope(scope, namespace),
      narrow: (items) =>
        several
          ? items.filter((item) => inScope(scope, item.namespace))
          : items,
    };
  }, [scope, t]);
}
