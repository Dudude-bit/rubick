/**
 * Every query parameter a screen under a cluster reads. Unknown keys are
 * dropped on the way in, and every value is a string: the router's default
 * parser turns `?q=123` into a number, which no reader here expects.
 */
export interface AppSearch {
  peek?: string;
  q?: string;
  tab?: string;
  view?: string;
  range?: string;
  since?: string;
  shell?: string;
  vendor?: string;
  rule?: string;
  monitor?: string;
  kind?: string;
  /** The attached object a redirect came from, as `<resource>/[<namespace>/]<name>`. */
  via?: string;
}

const KEYS: ReadonlyArray<keyof AppSearch> = [
  "peek",
  "q",
  "tab",
  "view",
  "range",
  "since",
  "shell",
  "vendor",
  "rule",
  "monitor",
  "via",
  "kind",
];

export function appSearch(raw: Record<string, unknown>): AppSearch {
  const search: AppSearch = {};
  for (const key of KEYS) {
    const value = raw[key];
    if (typeof value === "string" && value !== "") search[key] = value;
    else if (typeof value === "number" || typeof value === "boolean")
      search[key] = String(value);
  }
  return search;
}
