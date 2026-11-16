type Shape = [RegExp, string];

// scheme://user:pass@host, and a token standing alone before the host; a
// digest after the `@` is an image, not a host
const URL_USERINFO: Shape = [
  /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/?#@]+@)+(?!sha\d+:)/gi,
  "$1…@",
];
const JWT: Shape = [/\beyJ[A-Za-z0-9._-]{16,}/g, "…"];
// Access key ids and the tokens that announce themselves by prefix
const PREFIXED: Shape = [
  /\b(?:A[KS]IA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{30,}|glpat-[\w-]{20,}|xox[abprs]-[\w-]{10,}|[sr]k[-_]live[-_]\w{10,})\b/g,
  "…",
];

// ?token=…, &X-Amz-Signature=… in an address. Keyed, but only by a key a
// query string opens with `?` or `&` and ends with `=`, which no image tag does
const QUERY_SECRET: Shape = [
  /([?&](?:[\w.-]*(?:pass(?:word|wd)?|pwd|token|secret|api[-_]?key|access[-_]?key|signature|credential)[\w.-]*|sig|key|auth)=)[^\s&#"'<>)\]]+/gi,
  "$1…",
];

/**
 * The shapes that are a credential wherever they stand, in a name or an
 * address as much as in a sentence. The keyed ones below are not among
 * them: outside a log line they take `oauth2-proxy:v7.5` for a password.
 */
const CREDENTIAL_SHAPES: Shape[] = [URL_USERINFO, JWT, PREFIXED, QUERY_SECRET];

/**
 * What a line may not carry off this machine.
 *
 * The credential is almost always in the same line as the address: a DSN, a
 * JDBC URL, a bearer token a client echoed. Nothing here can be complete —
 * a log line is arbitrary text — so this removes the shapes a secret takes
 * rather than pretending to recognise secrets, and the copy beside it says
 * so instead of promising.
 */
const SECRET_SHAPES: Shape[] = [
  URL_USERINFO,
  // Authorization: Bearer …, and a bare JWT; before the keys below, which
  // would otherwise take "Bearer" for the value and leave the token
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 …"],
  JWT,
  PREFIXED,
  // password=…, DB_PASSWORD=…, "apiKey": "…", in query strings, env, logfmt
  // and JSON; a prefix or a quote before the colon is how most of them look
  [
    /([\w.-]*(?:pass(?:word|wd)?|pwd|token|secret|api[-_]?key|access[-_]?key|auth)[\w.-]*)(["']?\s*[=:]\s*)(?!(?:bearer|basic) )("[^"]*"|'[^']*'|[^\s&,;)}"']+)/gi,
    "$1$2…",
  ],
];

const without = (shapes: Shape[], text: string) =>
  shapes.reduce((out, [pattern, to]) => out.replace(pattern, to), text);

/**
 * A line with the shapes a secret takes taken out. Applied to everything
 * this app hands to somebody else — the search engine and the clipboard.
 */
export function redact(line: string): string {
  return without(SECRET_SHAPES, line);
}

/**
 * Any text the cluster wrote, without the credentials it carries: a
 * repository address with a token before its host or in its query string,
 * a controller's message quoting it. What a shared file prints and what a
 * screen draws of an address, a message or a printed column all pass here,
 * so the host and path stay and what unlocks them never shows.
 */
export function withoutCredentials(text: string): string {
  return without(CREDENTIAL_SHAPES, text);
}
