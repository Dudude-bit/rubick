/** spec.scope in the words the API resources page uses for the same fact. */
export const scopeKey = (scope: string) =>
  scope === "Namespaced" ? ("namespaced" as const) : ("clusterWide" as const);
