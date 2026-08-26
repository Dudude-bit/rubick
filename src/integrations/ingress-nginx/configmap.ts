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

import type { T } from "@/i18n/useT";
import { rawNote, sayFor, type RawReason } from "./annotations";

export interface SettingReading {
  key: string;
  value: string;
  said: string | null;
  raw: RawReason | null;
  /** Whether an Ingress can override it with the annotation of this name. */
  overridable: boolean;
}

export { rawNote };

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
const GLOBAL: Record<string, (value: string, t: T) => string | null> = {
  "allow-snippet-annotations": (value, t) => {
    const on = bool(value);
    if (on === null) return null;
    return on
      ? t("readings", "ngxSnippetsAllowed")
      : t("readings", "ngxSnippetsIgnored");
  },
  "annotations-risk-level": (value, t) =>
    ({
      critical: t("readings", "ngxRiskCritical"),
      high: t("readings", "ngxRiskHigh"),
      medium: t("readings", "ngxRiskMedium"),
      low: t("readings", "ngxRiskLow"),
    })[value.trim().toLowerCase()] ?? null,
  "use-forwarded-headers": (value, t) => {
    const on = bool(value);
    if (on === null) return null;
    return on
      ? "X-Forwarded-For from the client is trusted and passed through, which is right behind a load balancer and wrong when nginx faces the internet."
      : t("readings", "ngxForwardedReplaced");
  },
  "compute-full-forwarded-for": (value, t) =>
    bool(value) ? t("readings", "ngxForwardedAppended") : null,
  "enable-real-ip": (value, t) =>
    bool(value) ? t("readings", "ngxRealIpFromProxy") : null,
  "proxy-real-ip-cidr": (value, t) => {
    const ranges = some(value);
    return ranges === null
      ? null
      : t("readings", "ngxTrustedRanges", { ranges });
  },
  "server-tokens": (value, t) => {
    const on = bool(value);
    if (on === null) return null;
    return on
      ? t("readings", "ngxServerTokensOn")
      : t("readings", "ngxServerTokensOff");
  },
  "ssl-protocols": (value, t) => {
    const versions = some(value);
    return versions === null
      ? null
      : t("readings", "ngxTlsVersions", { versions });
  },
  hsts: (value, t) => {
    const on = bool(value);
    if (on === null) return null;
    return on ? t("readings", "ngxHstsOn") : t("readings", "ngxHstsOff");
  },
  "hsts-max-age": (value, t) => {
    const age = whole(value);
    return age === null ? null : t("readings", "ngxHstsAge", { age });
  },
  "use-http2": (value, t) => {
    const on = bool(value);
    if (on === null) return null;
    return on ? t("readings", "ngxHttp2On") : t("readings", "ngxHttp2Off");
  },
  "use-gzip": (value, t) => (bool(value) ? t("readings", "ngxGzipOn") : null),
  "worker-processes": (value, t) => {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "auto") {
      return t("readings", "ngxWorkersAuto");
    }
    const count = whole(value);
    return count === null ? null : t("count", "ngxWorkers", { n: count });
  },
  "max-worker-connections": (value, t) => {
    const count = whole(value);
    return count === null
      ? null
      : t("readings", "ngxWorkerConnections", { count });
  },
  "keep-alive": (value, t) => {
    const wait = whole(value);
    return wait === null
      ? null
      : t("readings", "ngxKeepaliveTimeout", { wait });
  },
  "keep-alive-requests": (value, t) => {
    const count = whole(value);
    return count === null
      ? null
      : t("readings", "ngxKeepaliveRequests", { count });
  },
  "upstream-keepalive-connections": (value, t) => {
    const count = whole(value);
    return count === null
      ? null
      : t("readings", "ngxUpstreamKeepalive", { count });
  },
  "disable-access-log": (value, t) =>
    bool(value) ? t("readings", "ngxAccessLogOff") : null,
  "error-log-level": (value, t) =>
    ({
      debug: t("readings", "ngxErrorDebug"),
      info: t("readings", "ngxErrorInfo"),
      notice: t("readings", "ngxErrorNotice"),
      warn: t("readings", "ngxErrorWarn"),
      error: t("readings", "ngxErrorError"),
    })[value.trim().toLowerCase()] ?? null,
  "enable-modsecurity": (value, t) =>
    bool(value) ? t("readings", "ngxModsecOn") : null,
  "enable-owasp-modsecurity-crs": (value, t) =>
    bool(value) ? t("readings", "ngxModsecOwasp") : null,
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
export function readSetting(key: string, value: string, t: T): SettingReading {
  const own = GLOBAL[key];
  if (own) {
    const said = own(value, t);
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
    const said = shared(value, {}, t);
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
export function readSettings(
  data: Record<string, string>,
  t: T
): SettingReading[] {
  return Object.entries(data)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => readSetting(key, value, t));
}
