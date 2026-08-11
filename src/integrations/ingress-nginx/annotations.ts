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

const seconds = (value: string) => {
  const number = whole(value);
  return number === null ? null : `${number} second${number === 1 ? "" : "s"}`;
};

/** What an entry may look at: its own value, and its Ingress's other keys. */
type Say = (value: string, siblings: Record<string, string>) => string | null;

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
    say: (value) => {
      const on = bool(value);
      if (on === null) return null;
      return on
        ? "Plain HTTP is answered with a redirect to HTTPS."
        : "Plain HTTP is served as it arrives; nothing upgrades the connection.";
    },
  },
  {
    suffix: "force-ssl-redirect",
    say: (value) => {
      const on = bool(value);
      if (on === null) return null;
      return on
        ? "Plain HTTP is redirected to HTTPS even though this Ingress declares no certificate of its own."
        : "The forced redirect to HTTPS is switched off here.";
    },
  },
  {
    suffix: "ssl-passthrough",
    say: (value) =>
      bool(value)
        ? "TLS is handed to the backend untouched — nginx terminates nothing and never sees the path."
        : null,
  },
  {
    suffix: "backend-protocol",
    say: (value) =>
      oneOf(value, {
        http: "nginx speaks plain HTTP to the backend.",
        https: "nginx speaks HTTPS to the backend.",
        grpc: "nginx speaks gRPC to the backend.",
        grpcs: "nginx speaks gRPC over TLS to the backend.",
        fcgi: "nginx speaks FastCGI to the backend.",
        ajp: "nginx speaks AJP to the backend.",
      }),
  },

  // What the path becomes
  {
    suffix: "rewrite-target",
    say: (value) => {
      const target = some(value);
      return target === null
        ? null
        : `The path is rewritten to ${target} before the backend sees it.`;
    },
  },
  {
    suffix: "use-regex",
    say: (value) =>
      bool(value)
        ? "The paths on this Ingress are read as regular expressions rather than as prefixes."
        : null,
  },
  {
    suffix: "app-root",
    say: (value) => {
      const root = some(value);
      return root === null ? null : `A request for / is redirected to ${root}.`;
    },
  },
  {
    suffix: "permanent-redirect",
    say: (value) => {
      const to = some(value);
      return to === null
        ? null
        : `Every request here is answered with a permanent redirect to ${to}; the backend is never reached.`;
    },
  },
  {
    suffix: "temporal-redirect",
    say: (value) => {
      const to = some(value);
      return to === null
        ? null
        : `Every request here is answered with a temporary redirect to ${to}.`;
    },
  },
  {
    suffix: "from-to-www-redirect",
    say: (value) =>
      bool(value)
        ? "A request for the www form of this host is redirected to the bare one."
        : null,
  },
  {
    suffix: "upstream-vhost",
    say: (value) => {
      const host = some(value);
      return host === null
        ? null
        : `The backend is sent Host: ${host} rather than the hostname the client asked for.`;
    },
  },

  // Limits
  {
    suffix: "proxy-body-size",
    say: (value) => {
      const limit = size(value);
      if (limit === null) return null;
      return limit === "0"
        ? "A request body of any size is accepted — there is no limit."
        : `A request body larger than ${limit} is refused with 413.`;
    },
  },
  {
    suffix: "proxy-buffer-size",
    say: (value) => {
      const limit = size(value);
      return limit === null
        ? null
        : `Up to ${limit} is set aside for the backend's response headers; a larger set of headers fails with 502.`;
    },
  },
  {
    suffix: "proxy-buffering",
    say: (value) =>
      oneOf(value, {
        on: "The response is buffered in nginx before any of it reaches the client.",
        off: "The response is streamed to the client as it arrives, which is what a long poll or an event stream needs.",
      }),
  },
  {
    suffix: "proxy-read-timeout",
    say: (value) => {
      const wait = seconds(value);
      return wait === null
        ? null
        : `nginx waits up to ${wait} between reads from the backend before giving up with 504.`;
    },
  },
  {
    suffix: "proxy-send-timeout",
    say: (value) => {
      const wait = seconds(value);
      return wait === null
        ? null
        : `nginx waits up to ${wait} while sending the request to the backend.`;
    },
  },
  {
    suffix: "proxy-connect-timeout",
    say: (value) => {
      const wait = seconds(value);
      return wait === null
        ? null
        : `nginx gives up after ${wait} if the backend does not accept the connection.`;
    },
  },
  {
    suffix: "limit-rps",
    say: (value) => {
      const rate = whole(value);
      return rate === null
        ? null
        : `One client address is allowed ${rate} request${rate === 1 ? "" : "s"} a second; the rest are refused with 503.`;
    },
  },
  {
    suffix: "limit-rpm",
    say: (value) => {
      const rate = whole(value);
      return rate === null
        ? null
        : `One client address is allowed ${rate} request${rate === 1 ? "" : "s"} a minute; the rest are refused with 503.`;
    },
  },
  {
    suffix: "limit-connections",
    say: (value) => {
      const count = whole(value);
      return count === null
        ? null
        : `One client address may hold ${count} connection${count === 1 ? "" : "s"} at a time.`;
    },
  },

  // Who is let through
  {
    suffix: "whitelist-source-range",
    say: (value) => {
      const ranges = list(value);
      return ranges === null
        ? null
        : `Only clients in ${ranges} are served; every other address is refused with 403.`;
    },
  },
  {
    suffix: "denylist-source-range",
    say: (value) => {
      const ranges = list(value);
      return ranges === null
        ? null
        : `Clients in ${ranges} are refused with 403; everybody else is served.`;
    },
  },
  {
    suffix: "auth-type",
    say: (value) =>
      oneOf(value, {
        basic:
          "Every request must carry HTTP basic authentication or it is refused with 401.",
        digest:
          "Every request must carry HTTP digest authentication or it is refused with 401.",
      }),
  },
  {
    suffix: "auth-secret",
    say: (value) => {
      const secret = some(value);
      return secret === null
        ? null
        : `The user names and password hashes are read from the Secret ${secret}.`;
    },
  },
  {
    suffix: "auth-realm",
    say: (value) => {
      const realm = some(value);
      return realm === null
        ? null
        : `The browser's password prompt is labelled “${realm}”.`;
    },
  },
  {
    suffix: "auth-url",
    say: (value) => {
      const url = some(value);
      return url === null
        ? null
        : `Every request is first sent to ${url}; anything but a 2xx from it refuses the request.`;
    },
  },
  {
    suffix: "auth-signin",
    say: (value) => {
      const url = some(value);
      return url === null
        ? null
        : `A request the authentication service refused is redirected to ${url} to sign in.`;
    },
  },
  {
    suffix: "enable-cors",
    say: (value) =>
      bool(value)
        ? "A browser on another origin is allowed to call this route."
        : null,
  },
  {
    suffix: "cors-allow-origin",
    say: (value) => {
      const origins = list(value);
      return origins === null
        ? null
        : `Cross-origin calls are allowed from ${origins}.`;
    },
  },

  // How traffic is split
  {
    suffix: "canary",
    say: (value) => {
      const on = bool(value);
      if (on === null) return null;
      return on
        ? "This is a second route for a host another Ingress already serves, and nginx sends it a share of that host's traffic."
        : "Canary routing is switched off here, so this route is served like any other.";
    },
  },
  {
    suffix: "canary-weight",
    say: (value, siblings) => {
      const weight = whole(value);
      if (weight === null) return null;
      const total = whole(siblings[`${PREFIX}canary-weight-total`] ?? "100");
      if (total === null || total === 0) return null;
      return total === 100
        ? `${weight}% of this host's requests take this route instead of the one it shadows.`
        : `${weight} of every ${total} requests for this host take this route instead of the one it shadows.`;
    },
  },
  {
    suffix: "canary-weight-total",
    say: (value) => {
      const total = whole(value);
      return total === null
        ? null
        : `The weight above is a share of ${total} rather than a percentage.`;
    },
  },
  {
    suffix: "canary-by-header",
    say: (value) => {
      const header = some(value);
      return header === null
        ? null
        : `A request carrying ${header}: always takes this route, and one carrying ${header}: never never does — which is checked before any weight is.`;
    },
  },
  {
    suffix: "canary-by-header-value",
    say: (value, siblings) => {
      const wanted = some(value);
      if (wanted === null) return null;
      const header = some(siblings[`${PREFIX}canary-by-header`] ?? "");
      return header === null
        ? null
        : `A request whose ${header} header is exactly ${wanted} takes this route.`;
    },
  },
  {
    suffix: "canary-by-cookie",
    say: (value) => {
      const cookie = some(value);
      return cookie === null
        ? null
        : `A request carrying the cookie ${cookie}=always takes this route, and ${cookie}=never never does.`;
    },
  },

  // Which pod, and what the endpoints mean
  {
    suffix: "affinity",
    say: (value) =>
      oneOf(value, {
        cookie:
          "One client keeps reaching the same backend pod, tracked with a cookie nginx sets.",
      }),
  },
  {
    suffix: "affinity-mode",
    say: (value) =>
      oneOf(value, {
        balanced:
          "Stickiness is given up when the set of pods changes, so a rollout rebalances.",
        persistent:
          "A client stays pinned to its pod across rollouts, so a scale-up takes no share of the existing traffic.",
      }),
  },
  {
    suffix: "session-cookie-name",
    say: (value) => {
      const name = some(value);
      return name === null ? null : `The stickiness cookie is called ${name}.`;
    },
  },
  {
    suffix: "load-balance",
    say: (value) =>
      oneOf(value, {
        round_robin: "Requests go to the backend's pods in turn.",
        ewma: "Each request goes to whichever pod has been answering fastest.",
      }),
  },
  {
    suffix: "service-upstream",
    say: (value) =>
      bool(value)
        ? "Requests are sent to the Service's cluster IP rather than to its pods, so kube-proxy picks the pod and nginx never sees the endpoints."
        : null,
  },
  {
    suffix: "default-backend",
    say: (value) => {
      const service = some(value);
      return service === null
        ? null
        : `A request this route cannot serve is answered by the Service ${service} instead.`;
    },
  },
  {
    suffix: "custom-http-errors",
    say: (value) => {
      const codes = list(value);
      return codes === null
        ? null
        : `A ${codes} from the backend is replaced by the default backend's own body rather than passed through.`;
    },
  },
  {
    suffix: "server-alias",
    say: (value) => {
      const aliases = list(value);
      return aliases === null
        ? null
        : `This route also answers for ${aliases}.`;
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
  siblings: Record<string, string> = {}
): AnnotationReading {
  const suffix = key.slice(PREFIX.length);

  if (isSnippet(suffix)) {
    return { key, value, said: null, raw: "snippet" };
  }

  const say = BY_SUFFIX.get(suffix);
  if (!say) return { key, value, said: null, raw: "notInTheTable" };

  const said = say(value, siblings);
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
  annotations: Record<string, string>
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
    .map(([key, value]) => readAnnotation(key, value, annotations));
}

/** The sentence a raw line carries instead of a paraphrase. */
export const RAW_NOTE: Record<RawReason, string> = {
  notInTheTable:
    "Shown as written — this app has no sentence for this key, and a guessed one would be worse than the key.",
  unreadableValue:
    "Shown as written — the key is one this app knows and the value is not a shape it can state.",
  snippet:
    "Raw nginx configuration, injected verbatim into the server block. Shown exactly as written; this app will not paraphrase it, because it can rewrite, redirect or deny anything on this route.",
};
