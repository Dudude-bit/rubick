/** kubectl's short names for typed kinds, by group and plural, for a cluster whose discovery said none. */
const KUBECTL_SHORT_NAMES: Readonly<Record<string, readonly string[]>> = {
  "/pods": ["po"],
  "apps/deployments": ["deploy"],
  "apps/statefulsets": ["sts"],
  "apps/daemonsets": ["ds"],
  "apps/replicasets": ["rs"],
  "batch/cronjobs": ["cj"],
  "autoscaling/horizontalpodautoscalers": ["hpa"],
  "policy/poddisruptionbudgets": ["pdb"],
  "/services": ["svc"],
  "/endpoints": ["ep"],
  "networking.k8s.io/ingresses": ["ing"],
  "networking.k8s.io/networkpolicies": ["netpol"],
  "/configmaps": ["cm"],
  "/serviceaccounts": ["sa"],
  "/persistentvolumeclaims": ["pvc"],
  "/persistentvolumes": ["pv"],
  "storage.k8s.io/storageclasses": ["sc"],
  "/namespaces": ["ns"],
  "/nodes": ["no"],
  "/events": ["ev"],
  "apiextensions.k8s.io/customresourcedefinitions": ["crd", "crds"],
};

/** What a kind answers to besides its names: its cluster's word first, the table's otherwise. */
export function shortNamesOf(kind: {
  group: string;
  plural: string;
  shortNames?: readonly string[];
}): readonly string[] {
  if (kind.shortNames && kind.shortNames.length > 0) return kind.shortNames;
  return KUBECTL_SHORT_NAMES[`${kind.group}/${kind.plural}`] ?? [];
}
