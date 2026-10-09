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
 * Files land on an offer and run nothing until the reader clicks. So this is
 * an allowlist, not a blocklist, and a param the app grows later stays out
 * until it is proven safe to open unattended.
 */
const SAFE_PARAMS = new Set(["tab", "vendor", "type", "namespace"]);

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
  const [root, clusterSegment, ...rest] = url.pathname
    .split("/")
    .filter(Boolean);
  if (root !== "c" || !clusterSegment) return null;
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
