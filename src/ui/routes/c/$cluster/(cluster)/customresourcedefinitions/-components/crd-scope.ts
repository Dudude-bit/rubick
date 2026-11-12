import type { T } from "@/i18n/useT";
import { widestText } from "@/lib/text-width";

/** spec.scope in the words the API resources page uses for the same fact. */
export const scopeKey = (scope: string) =>
  scope === "Namespaced" ? ("namespaced" as const) : ("clusterWide" as const);

/** Both scopes whole in the reader's language, and a cell's padding. */
export const scopeCellPx = (t: T) =>
  widestText(
    [t("apiResources", "namespaced"), t("apiResources", "clusterWide")],
    "sans",
    6.6
  ) + 20;
