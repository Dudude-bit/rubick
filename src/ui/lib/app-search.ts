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
  /** The `via` the peek's object was opened with, carried to its full page. */
  peekVia?: string;
  /** A label selector, as the API writes one, that narrows the Pods list. */
  selector?: string;
  /** The namespaces, comma-separated, that selector is read in. */
  in?: string;
  /** The plural of a kind with no list of its own, on the list that shows it instead. */
  listOf?: string;
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
  "peekVia",
  "kind",
  "selector",
  "in",
  "listOf",
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
