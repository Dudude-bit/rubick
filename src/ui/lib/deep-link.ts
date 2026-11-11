/**
 * `rubick://open/c/<cluster>/<app path>?t=<when>`: the place a person was in
 * the app, as text that survives a chat message and opens the same place
 * for someone else with Rubick.
 *
 * The path is the app's own address, so the cluster is its second segment,
 * percent-encoded, not the URL's host: hosts are lower-cased by every URL
 * parser and may not hold a `/`, and an EKS context name is an ARN with
 * both. `open` is the only host, so a link that says anything else is not
 * ours.
 *
 * A link only opens. Nothing in it names an action, and the parser would
 * not know what to do with one: the app never mutates on arrival.
 */

export const DEEP_LINK_SCHEME = "rubick";
const HOST = "open";

/**
 * The only query params an arriving link may carry: the ones that pick a
 * *view*, never one that makes the destination *act*.
 *
 * A link is untrusted (it comes from a chat message or a report), and it
 * opens on arrival with no click. A tab is a view: the pod page's Shell and
 * Files land on an offer and run nothing until the reader clicks. `view` only
 * picks a layout, or an attached object's own page over its parent's, and a
 * peek always opens on its Overview. So this is an allowlist, not a
 * blocklist, and a param the app grows later stays out until it is proven
 * safe to open unattended. `shell` is the one that is not: it names a
 * container and the pod page opens a terminal in it on arrival.
 */
const SAFE_PARAMS = new Set([
  // Which tab, layout, panel, vendor or selected row is drawn.
  "tab",
  "view",
  "peek",
  "peekVia",
  "via",
  "vendor",
  "type",
  "rule",
  "monitor",
  // Which namespace the window looks at: a read the reader could ask for.
  "namespace",
  // Narrow rows the page has already read, by text, kind, time or name.
  // Each is matched in the page against a fixed set or as plain text.
  "q",
  "kind",
  "range",
  "since",
  "names",
  "listOf",
  // Narrow the Pods list by label, matched in the page; a selector the app
  // cannot read shows no pod and says so.
  "selector",
  "in",
]);

const LEGACY_SECTIONS = new Set([
  "workloads",
  "network",
  "storage",
  "configuration",
]);

export interface DeepLink {
  /** The cluster the address names. */
  context: string;
  /** The in-app address, `/c/<cluster>/...`, with its search string when the page had one. */
  path: string;
  /** When the link was made, if it says. */
  capturedAt: Date | null;
}

/** One segment percent-encoded exactly once, whether or not it came encoded. */
function asSegment(segment: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(segment));
  } catch {
    return encodeURIComponent(segment);
  }
}

/** A link to `href`, an in-app address that already names its cluster. */
export function buildDeepLink(
  href: string,
  capturedAt: Date = new Date()
): string {
  const [pathname, search = ""] = href.split("?", 2);
  const segments = pathname.split("/").filter(Boolean).map(asSegment);
  const params = new URLSearchParams(search);
  params.set("t", capturedAt.toISOString().replace(/\.\d{3}Z$/, "Z"));
  return `${DEEP_LINK_SCHEME}://${HOST}/${segments.join("/")}?${params}`;
}

/** The link's parts, or `null` for anything that is not one of ours. */
export function parseDeepLink(raw: string): DeepLink | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:` || url.host !== HOST) return null;
  const [root, ...after] = url.pathname.split("/").filter(Boolean);
  if (!root) return null;
  // 4.11 to 4.21 wrote `open/<cluster>/<section>/<plural>/...`; the
  // sections are now pathless route groups.
  const [clusterSegment, ...rest] =
    root === "c"
      ? after
      : [root, ...(LEGACY_SECTIONS.has(after[0]) ? after.slice(1) : after)];
  if (!clusterSegment) return null;
  let context: string;
  let segments: string[];
  try {
    context = decodeURIComponent(clusterSegment);
    segments = rest.map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
  if ([context, ...segments].some((s) => s === "." || s === "..")) return null;
  const params = new URLSearchParams(url.search);
  const stamp = params.get("t");
  const safe = new URLSearchParams();
  for (const [key, value] of params) {
    if (SAFE_PARAMS.has(key)) safe.set(key, value);
  }
  const capturedAt = stamp ? new Date(stamp) : null;
  const search = safe.toString();
  const path = ["c", context, ...segments].map(encodeURIComponent).join("/");
  return {
    context,
    path: `/${path}${search ? `?${search}` : ""}`,
    capturedAt:
      capturedAt && !Number.isNaN(capturedAt.getTime()) ? capturedAt : null,
  };
}
