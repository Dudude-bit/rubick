/**
 * The one object in the cluster that changes the behaviour of every nginx
 * route at once, and which nothing in this app has ever shown.
 *
 * The controller is started with `--configmap=<namespace>/<name>` and reads
 * that ConfigMap live: a key set in it applies to every server block nginx
 * generates, unless an Ingress overrides it with the annotation of the same
 * name. So a route that reads perfectly on the Routes tab can still be
 * behaving in a way nothing on that tab explains — a 413 at 1MB because the
 * global `proxy-body-size` says so, a snippet silently ignored because
 * `allow-snippet-annotations` is false.
 *
 * The reading rule is the annotations' rule, unchanged: a key with a
 * sentence gets one, everything else is shown as written, and the raw key
 * stays beside every line either way. Where a key means the same thing here
 * as it does on an Ingress the sentence is literally the same one — see
 * {@link sayFor} — because two tables for one word is how two screens start
 * disagreeing.
 */

import { RAW_NOTE, sayFor, type RawReason } from "./annotations";

export interface SettingReading {
  key: string;
  value: string;
  said: string | null;
  raw: RawReason | null;
  /** Whether an Ingress can override it with the annotation of this name. */
  overridable: boolean;
}

export { RAW_NOTE };

function bool(value: string): boolean | null {
  const lowered = value.trim().toLowerCase();
  if (lowered === "true") return true;
  if (lowered === "false") return false;
  return null;
}

function whole(value: string): number | null {
  return /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
}

function some(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The keys that exist only here — the ones that are about the proxy rather
 * than about a route, and so have no annotation to share a sentence with.
 */
const GLOBAL: Record<string, (value: string) => string | null> = {
  "allow-snippet-annotations": (value) => {
    const on = bool(value);
    if (on === null) return null;
    return on
      ? "An Ingress in this cluster may inject raw nginx configuration through configuration-snippet and server-snippet."
      : "configuration-snippet and server-snippet on an Ingress are ignored — an Ingress carrying one is not doing what it says.";
  },
  "annotations-risk-level": (value) =>
    ({
      critical:
        "Every annotation is honoured, including the ones that can execute configuration.",
      high: "Annotations up to the High risk level are honoured; Critical ones — the snippets — are ignored.",
      medium:
        "Only Low and Medium risk annotations are honoured; anything above is ignored.",
      low: "Only Low risk annotations are honoured; most of the interesting ones are ignored.",
    })[value.trim().toLowerCase()] ?? null,
  "use-forwarded-headers": (value) => {
    const on = bool(value);
    if (on === null) return null;
    return on
      ? "X-Forwarded-For from the client is trusted and passed through, which is right behind a load balancer and wrong when nginx faces the internet."
      : "X-Forwarded-For from the client is replaced with the address nginx actually saw.";
  },
  "compute-full-forwarded-for": (value) =>
    bool(value)
      ? "The client's address is appended to X-Forwarded-For rather than replacing it."
      : null,
  "enable-real-ip": (value) =>
    bool(value)
      ? "The client's real address is taken from the proxy protocol or the forwarded header rather than from the connection."
      : null,
  "proxy-real-ip-cidr": (value) => {
    const ranges = some(value);
    return ranges === null
      ? null
      : `Forwarded headers are trusted only from ${ranges}; from anywhere else they are ignored.`;
  },
  "server-tokens": (value) => {
    const on = bool(value);
    if (on === null) return null;
    return on
      ? "Responses carry the nginx version in the Server header."
      : "The nginx version is kept out of responses and error pages.";
  },
  "ssl-protocols": (value) => {
    const versions = some(value);
    return versions === null
      ? null
      : `Only ${versions} are offered to clients; anything older is refused at the handshake.`;
  },
  hsts: (value) => {
    const on = bool(value);
    if (on === null) return null;
    return on
      ? "Every TLS response tells the browser to refuse plain HTTP to this host in future."
      : "No Strict-Transport-Security header is sent, so a browser will try plain HTTP again.";
  },
  "hsts-max-age": (value) => {
    const age = whole(value);
    return age === null
      ? null
      : `The browser is told to remember that for ${age} seconds.`;
  },
  "use-http2": (value) => {
    const on = bool(value);
    if (on === null) return null;
    return on
      ? "HTTP/2 is offered on the TLS listener."
      : "HTTP/2 is switched off; every client falls back to HTTP/1.1.";
  },
  "use-gzip": (value) =>
    bool(value) ? "Responses are compressed before they leave nginx." : null,
  "worker-processes": (value) => {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "auto") {
      return "One nginx worker per CPU the container is allowed.";
    }
    const count = whole(value);
    return count === null
      ? null
      : `${count} nginx worker${count === 1 ? "" : "s"}, whatever the container's CPU allowance is.`;
  },
  "max-worker-connections": (value) => {
    const count = whole(value);
    return count === null
      ? null
      : `One worker holds at most ${count} connections; past that new ones wait.`;
  },
  "keep-alive": (value) => {
    const wait = whole(value);
    return wait === null
      ? null
      : `An idle client connection is held open for ${wait} seconds before nginx closes it.`;
  },
  "keep-alive-requests": (value) => {
    const count = whole(value);
    return count === null
      ? null
      : `A client connection is reused for ${count} requests and then closed.`;
  },
  "upstream-keepalive-connections": (value) => {
    const count = whole(value);
    return count === null
      ? null
      : `${count} idle connections per backend are kept open for reuse.`;
  },
  "disable-access-log": (value) =>
    bool(value)
      ? "Nothing is written to the access log, so this controller's logs will not show a request that reached it."
      : null,
  "error-log-level": (value) =>
    ({
      debug: "The error log carries everything, including per-request detail.",
      info: "The error log carries informational messages and worse.",
      notice: "The error log carries notices and worse.",
      warn: "The error log carries warnings and worse.",
      error: "The error log carries errors only.",
    })[value.trim().toLowerCase()] ?? null,
  "enable-modsecurity": (value) =>
    bool(value)
      ? "Every request is passed through ModSecurity before it reaches a backend."
      : null,
  "enable-owasp-modsecurity-crs": (value) =>
    bool(value)
      ? "ModSecurity runs with the OWASP core rule set loaded."
      : null,
};

/** How many settings this app will state a sentence about, its own plus the
 *  annotation table's — every one of those keys is settable here too. */
export const GLOBAL_KEYS = Object.keys(GLOBAL).length;

/**
 * Read one key of the global ConfigMap.
 *
 * A key with an annotation of the same name is marked overridable, because
 * that is the difference between "this is what happens" and "this is what
 * happens unless the Ingress said otherwise" — and the reader chasing why
 * one route behaves differently from the rest needs to know which they are
 * looking at.
 */
export function readSetting(key: string, value: string): SettingReading {
  const own = GLOBAL[key];
  if (own) {
    const said = own(value);
    return {
      key,
      value,
      said,
      raw: said === null ? "unreadableValue" : null,
      overridable: false,
    };
  }

  const shared = sayFor(key);
  if (shared) {
    const said = shared(value, {});
    return {
      key,
      value,
      said,
      raw: said === null ? "unreadableValue" : null,
      overridable: true,
    };
  }

  return { key, value, said: null, raw: "notInTheTable", overridable: false };
}

/**
 * Every key in the ConfigMap, decoded as far as each can be.
 *
 * Alphabetical, unlike the annotations. There is no reading order to a list
 * of global settings — nobody arrives at it chasing a request through a
 * chain — and a reader here is looking up a key they already have in mind.
 */
export function readSettings(data: Record<string, string>): SettingReading[] {
  return Object.entries(data)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => readSetting(key, value));
}
