/**
 * `rubick://open/<context>/<app path>?t=<when>`: the place a person was in
 * the app, as text that survives a chat message and opens the same place
 * for someone else with Rubick.
 *
 * The context is a path segment, percent-encoded, not the URL's host: hosts
 * are lower-cased by every URL parser and may not hold a `/`, and an EKS
 * context name is an ARN with both. `open` is the only host, so a link that
 * says anything else is not ours.
 *
 * A link only opens. Nothing in it names an action, and the parser would
 * not know what to do with one: the app never mutates on arrival.
 */

export const DEEP_LINK_SCHEME = "rubick";
const HOST = "open";

/**
 * The only query params an arriving link may carry — the ones that pick a
 * *view*, never one that makes the destination *act*.
 *
 * A link is untrusted (it comes from a chat message or a report), and it
 * opens on arrival with no click. `?shell=<container>` and `?tab=shell` both
 * make the pod page open an exec session into a container the moment it
 * mounts — a real change to the cluster from a link somebody was handed. So
 * this is an allowlist, not a blocklist: only these view-selection params
 * survive parsing, `shell` is not among them, and the `shell` *tab* is
 * dropped even though `tab` is allowed. A param the app grows later stays out
 * until it is proven safe to open unattended.
 */
const SAFE_PARAMS = new Set(["tab", "vendor", "type"]);

export interface DeepLink {
  context: string;
  /** The router path, with its search string when the page had one. */
  path: string;
  /** When the link was made, if it says. */
  capturedAt: Date | null;
}

export function buildDeepLink(
  context: string,
  path: string,
  capturedAt: Date = new Date()
): string {
  const [pathname, search = ""] = path.split("?", 2);
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map((s) => encodeURIComponent(s));
  const params = new URLSearchParams(search);
  params.set("t", capturedAt.toISOString().replace(/\.\d{3}Z$/, "Z"));
  return `${DEEP_LINK_SCHEME}://${HOST}/${encodeURIComponent(context)}/${segments.join("/")}?${params}`;
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
  const [contextSegment, ...rest] = url.pathname.split("/").filter(Boolean);
  if (!contextSegment) return null;
  let context: string;
  let segments: string[];
  try {
    context = decodeURIComponent(contextSegment);
    segments = rest.map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
  if (segments.some((s) => s === "." || s === "..")) return null;
  const params = new URLSearchParams(url.search);
  const stamp = params.get("t");
  // Keep only the view-selection params, and never the shell tab — an
  // arriving link opens unattended and must land on something read-only.
  const safe = new URLSearchParams();
  for (const [key, value] of params) {
    if (!SAFE_PARAMS.has(key)) continue;
    if (key === "tab" && value === "shell") continue;
    safe.set(key, value);
  }
  const capturedAt = stamp ? new Date(stamp) : null;
  const search = safe.toString();
  return {
    context,
    path: `/${segments.join("/")}${search ? `?${search}` : ""}`,
    capturedAt:
      capturedAt && !Number.isNaN(capturedAt.getTime()) ? capturedAt : null,
  };
}
