/** Everything before the last `@` of the authority, with or without a scheme. */
const USERINFO = /^(\s*(?:[a-z][a-z0-9+.-]*:\/\/)?)[^/?#]*@/i;

/**
 * A saved address as it may be drawn: `https://user:pass@host` is the one
 * way this app has to send basic credentials, so every caption, row and
 * file names the host and never what stands before it. Cut by hand rather
 * than parsed, so an address too malformed to parse loses them too.
 */
export function addressOf(url: string): { shown: string; basic: boolean } {
  const bare = url.replace(USERINFO, "$1");
  return {
    shown: bare
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, ""),
    basic: bare !== url,
  };
}
