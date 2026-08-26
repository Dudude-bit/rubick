import type { T } from "@/i18n/useT";
/**
 * ingress-nginx's behaviour is a program written in annotations, and this
 * reads the part of it that can be read exactly.
 *
 * A plain Ingress carrying twelve `nginx.ingress.kubernetes.io/*` keys is a
 * routing configuration, and every screen in this app today renders it as an
 * annotation blob you have to already know how to read. Decoded it is five
 * decisions in five sentences.
 *
 * ## The rule the whole file is built on
 *
 * **Anything the app cannot state confidently is shown raw and said to be
 * raw**, and the raw key stays beside every decoded line whether or not it
 * was decoded. Three things follow from that and none of them is negotiable:
 *
 * - A key not in {@link TABLE} is printed as written. There are around
 *   ninety of these annotations and this table holds the ones worth a
 *   sentence; the rest are not guessed at, and the table growing is a normal
 *   thing that happens later.
 * - A key *in* the table whose value is not a shape it recognises is also
 *   printed as written. `proxy-body-size: enormous` is not 413 at some size
 *   this app invented, and an entry that returns `null` for a value it
 *   cannot parse is the mechanism for saying so.
 * - {@link isSnippet} keys are **never** paraphrased at any confidence.
 *   `configuration-snippet` is raw nginx configuration injected verbatim
 *   into the server block; it can rewrite, redirect, deny or proxy anywhere,
 *   and no summary of it is safe. It is shown as written and flagged as raw
 *   nginx config.
 *
 * A wrong paraphrase of a routing rule is worse than the annotation nobody
 * read, because this time somebody believed it.
 */

/** Every one of these annotations starts here. */
export const PREFIX = "nginx.ingress.kubernetes.io/";

/** Why a line carries the value instead of a sentence. */
export type RawReason =
  /** Not in the table. The table is a shortlist, not a specification. */
  | "notInTheTable"
  /** In the table, and this value is not a shape it can state. */
  | "unreadableValue"
  /** Raw nginx configuration. Never paraphrased, at any confidence. */
  | "snippet";

export interface AnnotationReading {
  /** The key exactly as written, shown beside every line either way. */
  key: string;
  value: string;
  /** What it does, in one sentence — or `null`, which is the finding. */
  said: string | null;
  raw: RawReason | null;
}

/**
 * The keys whose value is nginx configuration rather than a setting.
 *
 * Separate from the table because they are not a gap in it: adding an entry
 * for `configuration-snippet` would be the mistake, not the fix.
 */
export function isSnippet(suffix: string): boolean {
  return suffix.endsWith("-snippet");
}

// --- the shapes a value is allowed to have ------------------------------

/** `true`/`false`, in either case, and nothing else. */
function bool(value: string): boolean | null {
  const lowered = value.trim().toLowerCase();
  if (lowered === "true") return true;
  if (lowered === "false") return false;
  return null;
}

/** A whole number. A timeout of `30s` is not a thing nginx accepts here. */
function whole(value: string): number | null {
  return /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
}

/** nginx's own size spelling: `8m`, `1024`, `512k`. */
function size(value: string): string | null {
  const trimmed = value.trim();
  return /^\d+[kmg]?$/i.test(trimmed) ? trimmed : null;
}

/** A non-empty value, for the keys whose content is a name or an address. */
function some(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** A comma-separated list, said back as one. */
function list(value: string): string | null {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length === 0 ? null : parts.join(", ");
}

/** One of a fixed set, case-insensitively — or nothing, which means raw. */
function oneOf(value: string, options: Record<string, string>): string | null {
  return options[value.trim().toLowerCase()] ?? null;
}

const seconds = (value: string, t: T) => {
  const number = whole(value);
  return number === null ? null : t("count", "nginxSeconds", { n: number });
};

/** What an entry may look at: its own value, and its Ingress's other keys. */
type Say = (
  value: string,
  siblings: Record<string, string>,
  t: T
) => string | null;

/**
 * The annotations worth a sentence, in the order they are read in.
 *
 * Ordered by what a reader chasing a broken URL looks at first — whether the
 * connection is encrypted, then what the path becomes, then who is let
 * through, then how traffic is split — rather than alphabetically. A
 * fourteen-line block ordered by the alphabet is a fourteen-line block.
 */
const TABLE: ReadonlyArray<{ suffix: string; say: Say }> = [
  // Encryption
  {
    suffix: "ssl-redirect",
    say: (value, _siblings, t) => {
      const on = bool(value);
      if (on === null) return null;
      return on
        ? t("readings", "nginxSslRedirectOn")
        : t("readings", "nginxSslRedirectOff");
    },
  },
  {
    suffix: "force-ssl-redirect",
    say: (value, _siblings, t) => {
      const on = bool(value);
      if (on === null) return null;
      return on
        ? t("readings", "nginxForceSslOn")
        : t("readings", "nginxForceSslOff");
    },
  },
  {
    suffix: "ssl-passthrough",
    say: (value, _siblings, t) =>
      bool(value) ? t("readings", "nginxSslPassthrough") : null,
  },
  {
    suffix: "backend-protocol",
    say: (value, _siblings, t) =>
      oneOf(value, {
        http: t("readings", "nginxBackendHttp"),
        https: t("readings", "nginxBackendHttps"),
        grpc: t("readings", "nginxBackendGrpc"),
        grpcs: t("readings", "nginxBackendGrpcs"),
        fcgi: t("readings", "nginxBackendFcgi"),
        ajp: t("readings", "nginxBackendAjp"),
      }),
  },

  // What the path becomes
  {
    suffix: "rewrite-target",
    say: (value, _siblings, t) => {
      const target = some(value);
      return target === null
        ? null
        : t("readings", "nginxRewriteTarget", { target });
    },
  },
  {
    suffix: "use-regex",
    say: (value, _siblings, t) =>
      bool(value) ? t("readings", "nginxRegexPaths") : null,
  },
  {
    suffix: "app-root",
    say: (value, _siblings, t) => {
      const root = some(value);
      return root === null ? null : t("readings", "nginxAppRoot", { root });
    },
  },
  {
    suffix: "permanent-redirect",
    say: (value, _siblings, t) => {
      const to = some(value);
      return to === null
        ? null
        : t("readings", "nginxPermanentRedirect", { to });
    },
  },
  {
    suffix: "temporal-redirect",
    say: (value, _siblings, t) => {
      const to = some(value);
      return to === null
        ? null
        : t("readings", "nginxTemporalRedirect", { to });
    },
  },
  {
    suffix: "from-to-www-redirect",
    say: (value, _siblings, t) =>
      bool(value) ? t("readings", "nginxFromWww") : null,
  },
  {
    suffix: "upstream-vhost",
    say: (value, _siblings, t) => {
      const host = some(value);
      return host === null
        ? null
        : t("readings", "nginxUpstreamHost", { host });
    },
  },

  // Limits
  {
    suffix: "proxy-body-size",
    say: (value, _siblings, t) => {
      const limit = size(value);
      if (limit === null) return null;
      return limit === "0"
        ? t("readings", "nginxBodyUnlimited")
        : t("readings", "nginxBodyLimit", { limit });
    },
  },
  {
    suffix: "proxy-buffer-size",
    say: (value, _siblings, t) => {
      const limit = size(value);
      return limit === null
        ? null
        : t("readings", "nginxHeaderBuffer", { limit });
    },
  },
  {
    suffix: "proxy-buffering",
    say: (value, _siblings, t) =>
      oneOf(value, {
        on: t("readings", "nginxBuffered"),
        off: t("readings", "nginxStreamed"),
      }),
  },
  {
    suffix: "proxy-read-timeout",
    say: (value, _siblings, t) => {
      const wait = seconds(value, t);
      return wait === null ? null : t("readings", "nginxReadTimeout", { wait });
    },
  },
  {
    suffix: "proxy-send-timeout",
    say: (value, _siblings, t) => {
      const wait = seconds(value, t);
      return wait === null ? null : t("readings", "nginxSendTimeout", { wait });
    },
  },
  {
    suffix: "proxy-connect-timeout",
    say: (value, _siblings, t) => {
      const wait = seconds(value, t);
      return wait === null
        ? null
        : t("readings", "nginxConnectTimeout", { wait });
    },
  },
  {
    suffix: "limit-rps",
    say: (value, _siblings, t) => {
      const rate = whole(value);
      return rate === null
        ? null
        : t("count", "nginxRatePerSecond", { n: rate });
    },
  },
  {
    suffix: "limit-rpm",
    say: (value, _siblings, t) => {
      const rate = whole(value);
      return rate === null
        ? null
        : t("count", "nginxRatePerMinute", { n: rate });
    },
  },
  {
    suffix: "limit-connections",
    say: (value, _siblings, t) => {
      const count = whole(value);
      return count === null
        ? null
        : t("count", "nginxConnections", { n: count });
    },
  },

  // Who is let through
  {
    suffix: "whitelist-source-range",
    say: (value, _siblings, t) => {
      const ranges = list(value);
      return ranges === null
        ? null
        : t("readings", "nginxWhitelist", { ranges });
    },
  },
  {
    suffix: "denylist-source-range",
    say: (value, _siblings, t) => {
      const ranges = list(value);
      return ranges === null
        ? null
        : t("readings", "nginxDenylist", { ranges });
    },
  },
  {
    suffix: "auth-type",
    say: (value, _siblings, t) =>
      oneOf(value, {
        basic: t("readings", "nginxAuthBasic"),
        digest: t("readings", "nginxAuthDigest"),
      }),
  },
  {
    suffix: "auth-secret",
    say: (value, _siblings, t) => {
      const secret = some(value);
      return secret === null
        ? null
        : t("readings", "nginxAuthSecret", { secret });
    },
  },
  {
    suffix: "auth-realm",
    say: (value, _siblings, t) => {
      const realm = some(value);
      return realm === null ? null : t("readings", "nginxAuthRealm", { realm });
    },
  },
  {
    suffix: "auth-url",
    say: (value, _siblings, t) => {
      const url = some(value);
      return url === null ? null : t("readings", "nginxAuthUrl", { url });
    },
  },
  {
    suffix: "auth-signin",
    say: (value, _siblings, t) => {
      const url = some(value);
      return url === null ? null : t("readings", "nginxAuthSignin", { url });
    },
  },
  {
    suffix: "enable-cors",
    say: (value, _siblings, t) =>
      bool(value) ? t("readings", "nginxCorsOn") : null,
  },
  {
    suffix: "cors-allow-origin",
    say: (value, _siblings, t) => {
      const origins = list(value);
      return origins === null
        ? null
        : t("readings", "nginxCorsOrigins", { origins });
    },
  },

  // How traffic is split
  {
    suffix: "canary",
    say: (value, _siblings, t) => {
      const on = bool(value);
      if (on === null) return null;
      return on
        ? t("readings", "nginxCanaryOn")
        : t("readings", "nginxCanaryOff");
    },
  },
  {
    suffix: "canary-weight",
    say: (value, siblings, t) => {
      const weight = whole(value);
      if (weight === null) return null;
      const total = whole(siblings[`${PREFIX}canary-weight-total`] ?? "100");
      if (total === null || total === 0) return null;
      return total === 100
        ? t("readings", "nginxCanaryWeightPercent", { weight })
        : t("readings", "nginxCanaryWeightOf", { weight, total });
    },
  },
  {
    suffix: "canary-weight-total",
    say: (value, _siblings, t) => {
      const total = whole(value);
      return total === null
        ? null
        : t("readings", "nginxCanaryTotal", { total });
    },
  },
  {
    suffix: "canary-by-header",
    say: (value, _siblings, t) => {
      const header = some(value);
      return header === null
        ? null
        : t("readings", "nginxCanaryHeader", { header });
    },
  },
  {
    suffix: "canary-by-header-value",
    say: (value, siblings, t) => {
      const wanted = some(value);
      if (wanted === null) return null;
      const header = some(siblings[`${PREFIX}canary-by-header`] ?? "");
      return header === null
        ? null
        : t("readings", "nginxCanaryHeaderValue", { header, wanted });
    },
  },
  {
    suffix: "canary-by-cookie",
    say: (value, _siblings, t) => {
      const cookie = some(value);
      return cookie === null
        ? null
        : t("readings", "nginxCanaryCookie", { cookie });
    },
  },

  // Which pod, and what the endpoints mean
  {
    suffix: "affinity",
    say: (value, _siblings, t) =>
      oneOf(value, {
        cookie: t("readings", "nginxStickyCookie"),
      }),
  },
  {
    suffix: "affinity-mode",
    say: (value, _siblings, t) =>
      oneOf(value, {
        balanced: t("readings", "nginxStickyRebalance"),
        persistent: t("readings", "nginxStickyPersist"),
      }),
  },
  {
    suffix: "session-cookie-name",
    say: (value, _siblings, t) => {
      const name = some(value);
      return name === null
        ? null
        : t("readings", "nginxStickyCookieName", { name });
    },
  },
  {
    suffix: "load-balance",
    say: (value, _siblings, t) =>
      oneOf(value, {
        round_robin: t("readings", "nginxRoundRobin"),
        ewma: t("readings", "nginxLeastTime"),
      }),
  },
  {
    suffix: "service-upstream",
    say: (value, _siblings, t) =>
      bool(value) ? t("readings", "nginxServiceUpstream") : null,
  },
  {
    suffix: "default-backend",
    say: (value, _siblings, t) => {
      const service = some(value);
      return service === null
        ? null
        : t("readings", "nginxDefaultBackend", { service });
    },
  },
  {
    suffix: "custom-http-errors",
    say: (value, _siblings, t) => {
      const codes = list(value);
      return codes === null
        ? null
        : t("readings", "nginxCustomErrors", { codes });
    },
  },
  {
    suffix: "server-alias",
    say: (value, _siblings, t) => {
      const aliases = list(value);
      return aliases === null
        ? null
        : t("readings", "nginxServerAlias", { aliases });
    },
  },
];

/** How many annotations this app will state a sentence about. */
export const TABLE_SIZE = TABLE.length;

const BY_SUFFIX = new Map(TABLE.map((entry) => [entry.suffix, entry.say]));

/**
 * The sentence for one key, for the other reader of the same vocabulary.
 *
 * The global ConfigMap sets a dozen of these same keys cluster-wide —
 * `proxy-body-size` means the same thing there as it does on an Ingress —
 * and a second table repeating them is how the two screens start saying
 * different things about one word.
 */
export function sayFor(suffix: string): Say | undefined {
  return BY_SUFFIX.get(suffix);
}

/**
 * Read one annotation, with the raw key kept whatever the answer is.
 */
export function readAnnotation(
  key: string,
  value: string,
  t: T,
  siblings: Record<string, string> = {}
): AnnotationReading {
  const suffix = key.slice(PREFIX.length);

  if (isSnippet(suffix)) {
    return { key, value, said: null, raw: "snippet" };
  }

  const say = BY_SUFFIX.get(suffix);
  if (!say) return { key, value, said: null, raw: "notInTheTable" };

  const said = say(value, siblings, t);
  return said === null
    ? { key, value, said: null, raw: "unreadableValue" }
    : { key, value, said, raw: null };
}

/**
 * Every nginx annotation on one object, decoded as far as each can be.
 *
 * In the table's order, then the ones with nothing said about them, and the
 * snippets last — they are the longest and the one thing on the list that
 * has to be read in full rather than glanced at.
 */
export function readAnnotations(
  annotations: Record<string, string>,
  t: T
): AnnotationReading[] {
  const mine = Object.entries(annotations).filter(([key]) =>
    key.startsWith(PREFIX)
  );

  const rank = (key: string): number => {
    const suffix = key.slice(PREFIX.length);
    if (isSnippet(suffix)) return TABLE.length + 2;
    const index = TABLE.findIndex((entry) => entry.suffix === suffix);
    return index === -1 ? TABLE.length + 1 : index;
  };

  return mine
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([key, value]) => readAnnotation(key, value, t, annotations));
}

/**
 * The sentence a raw line carries instead of a paraphrase.
 *
 * A function rather than a table: the sentences are prose and the table was
 * built once, at module load, in whatever language happened to be first.
 */
export function rawNote(reason: RawReason, t: T): string {
  switch (reason) {
    case "notInTheTable":
      return t("readings", "nginxRawUnknownKey");
    case "unreadableValue":
      return t("readings", "nginxRawUnknownValue");
    case "snippet":
      return t("readings", "nginxRawSnippet");
  }
}
