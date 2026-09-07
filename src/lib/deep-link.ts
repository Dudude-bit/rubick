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
  params.delete("t");
  const capturedAt = stamp ? new Date(stamp) : null;
  const search = params.toString();
  return {
    context,
    path: `/${segments.join("/")}${search ? `?${search}` : ""}`,
    capturedAt:
      capturedAt && !Number.isNaN(capturedAt.getTime()) ? capturedAt : null,
  };
}
