/**
 * Container image references, and the one place in free text they may be
 * recognised.
 *
 * Two separate jobs live here on purpose. `parseImageRef` is the *grammar*:
 * given something already known to be an image — a container's `image` field,
 * the inside of a quoted reference — it says how to split it. `linkifyImages`
 * is the *detector*: given a sentence, it says which spans are images at all.
 * Keeping them apart is what stops the grammar from being run over prose,
 * where it would happily claim `ratio:0.82` and `10.42.0.6:8080`.
 */

export interface ImageReference {
  /** Exactly what was parsed, for the clipboard. */
  reference: string;
  /** `null` for a bare `busybox`, where the daemon supplies the default. */
  registry: string | null;
  /** The part a reader recognises: `busybox`, `project/sub/app`. */
  repository: string;
  tag: string | null;
  digest: string | null;
}

/**
 * `algorithm:hex`, per the distribution spec. The hex floor of 32 is what
 * keeps a plain `sha256:abc` — the shape a truncated log line has — out.
 */
const DIGEST = /^[a-z][a-z0-9]*(?:[.+_-][a-z0-9]+)*:[0-9a-fA-F]{32,}$/;
/** A tag may carry upper case and underscores; a repository path may not. */
const TAG = /^\w[\w.-]{0,127}$/;
const PATH_COMPONENT = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*$/;
const DOMAIN =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*(?::\d{1,5})?$/;

/** Nothing legal is anywhere near this long; a runaway string is not a ref. */
const MAX_LENGTH = 512;

export function parseImageRef(input: string): ImageReference | null {
  if (!input || input.length > MAX_LENGTH || /\s/.test(input)) return null;

  let rest = input;

  let digest: string | null = null;
  const at = rest.indexOf("@");
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST.test(digest)) return null;
  }

  // The tag's colon is the last one, and only if no `/` follows it —
  // otherwise the colon belongs to a registry port, as in `localhost:5000/app`.
  let tag: string | null = null;
  const colon = rest.lastIndexOf(":");
  if (colon !== -1 && !rest.slice(colon + 1).includes("/")) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!TAG.test(tag)) return null;
  }

  // A first path component is a registry only when it looks like a host:
  // a dot, a port, or the literal `localhost`. `project/app` has none of
  // those and is a two-part repository on the default registry.
  let registry: string | null = null;
  const slash = rest.indexOf("/");
  if (slash > 0) {
    const head = rest.slice(0, slash);
    if (head === "localhost" || head.includes(".") || head.includes(":")) {
      if (!DOMAIN.test(head)) return null;
      registry = head;
      rest = rest.slice(slash + 1);
    }
  }

  if (!rest) return null;
  const components = rest.split("/");
  if (!components.every((component) => PATH_COMPONENT.test(component))) {
    return null;
  }

  return { reference: input, registry, repository: rest, tag, digest };
}

export type MessageSegment =
  | { kind: "text"; text: string }
  | { kind: "image"; ref: ImageReference };

/**
 * The only shape trusted in free text: the word `image` (or `images`),
 * whitespace, then a double-quoted reference. Every kubelet message that
 * names one says it this way — `Container image "x" already present on
 * machine`, `Failed to pull image "x"`, `Back-off pulling image "x"`.
 *
 * The quotes are consumed with the match so the renderer owns them; a copy
 * affordance sitting inside the quotation marks reads as part of the string
 * being quoted.
 */
const LABELLED_IMAGE = /\bimages?\s+"([^"\n]+)"/gi;

export function linkifyImages(message: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let cursor = 0;

  LABELLED_IMAGE.lastIndex = 0;
  for (
    let match = LABELLED_IMAGE.exec(message);
    match !== null;
    match = LABELLED_IMAGE.exec(message)
  ) {
    const ref = parseImageRef(match[1]);
    // Labelled but unparseable — an empty pair of quotes, a sentence where
    // the reference should be. Prose is the safe reading.
    if (!ref) continue;
    // The quotes belong to the image segment; the word `image ` before them
    // stays prose.
    const start = match.index + match[0].length - match[1].length - 2;
    if (start > cursor) {
      segments.push({ kind: "text", text: message.slice(cursor, start) });
    }
    segments.push({ kind: "image", ref });
    cursor = match.index + match[0].length;
  }

  if (cursor < message.length) {
    segments.push({ kind: "text", text: message.slice(cursor) });
  }
  return segments;
}
