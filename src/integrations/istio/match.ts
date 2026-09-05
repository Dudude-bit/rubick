/**
 * A VirtualService's `match` is a small language, and this reads the part of
 * it that says *which requests take this route* — nothing else.
 *
 * `uri: {prefix: /api}` with a header or two is most of what anybody writes.
 * The rest — `queryParams`, `sourceLabels`, `withoutHeaders`, every regular
 * expression — is not paraphrased, because a wrong paraphrase of a routing
 * rule is worse than the raw block. A reader who sees the match as written
 * can check it; one told "serves /api" by a parser that quietly dropped
 * `sourceLabels` cannot.
 *
 * The conditions inside one `match` entry are ANDed, so they only ever
 * narrow: if an entry requires `uri.prefix: /api` and also something this
 * parser cannot read, every request taking the route is still a request under
 * `/api`. Stating that term is a fact. The unread condition is kept verbatim
 * and the surface prints the whole entry beside it.
 *
 * Two things break that and are refused for the whole entry. A regular
 * expression, because there is no sentence about it shorter than the regex
 * itself. And `ignoreUriCase`, because it changes what every other URI term
 * in the entry means.
 *
 * A list of entries *is* read, because it needs no precedence: Istio takes a
 * request satisfying any one of them, so they are independent alternatives.
 */

import type { T } from "@/i18n/useT";

/** One `match` entry, read as far as it can be read exactly. */
export interface MatchReading {
  /** What a request must satisfy, in sentences. Empty means "every request". */
  terms: string[];
  /**
   * The conditions that were not interpreted, verbatim. Non-empty means the
   * surface must show the entry as written and say it is doing so.
   */
  unread: string[];
  /** Why nothing at all could be read, in words a reader can act on. */
  refused: string | null;
  /** The entry exactly as written, for the raw fallback. */
  raw: string;
}

/** Istio's string matcher: one of three keys, and only two are readable. */
type StringMatch = { exact?: string; prefix?: string; regex?: string };

function readStringMatch(
  value: unknown,
  t: T,
  say: (how: string, what: string) => string
): { term: string | null; unread: boolean } {
  if (typeof value === "string") {
    // Istio accepts a bare string for `method` and friends in some
    // spellings, and reads it as an exact match.
    return { term: say(t("readings", "istioIsExactly"), value), unread: false };
  }
  if (typeof value !== "object" || value === null) {
    return { term: null, unread: true };
  }
  const match = value as StringMatch;
  if (typeof match.exact === "string") {
    return {
      term: say(t("readings", "istioIsExactly"), match.exact),
      unread: false,
    };
  }
  if (typeof match.prefix === "string") {
    return {
      term: say(t("readings", "istioStartsWith"), match.prefix),
      unread: false,
    };
  }
  // A regex is neither, and no sentence about it is shorter than itself.
  return { term: null, unread: true };
}

const verbatim = (key: string, value: unknown): string =>
  `${key}: ${JSON.stringify(value)}`;

/**
 * Read one `match` entry.
 *
 * An entry with no conditions at all is not a failure — it is a rule that
 * takes every request, which is a real and common configuration and the
 * thing a catch-all route is.
 */
export function readMatch(entry: unknown, t: T): MatchReading {
  const raw = JSON.stringify(entry, null, 2);

  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return {
      terms: [],
      unread: [],
      refused: t("readings", "istioUnreadableMatch"),
      raw,
    };
  }

  const conditions = entry as Record<string, unknown>;
  const terms: string[] = [];
  const unread: string[] = [];

  // Reading a URI term while dropping the flag that decides how it is
  // compared would state a requirement that is not the one in force.
  if (conditions.ignoreUriCase !== undefined) {
    return {
      terms: [],
      unread: [],
      refused: t("readings", "istioIgnoreUriCase"),
      raw,
    };
  }

  for (const [key, value] of Object.entries(conditions)) {
    switch (key) {
      case "name":
        // A label on the entry, not a condition on the request.
        break;
      case "uri": {
        const read = readStringMatch(value, t, (how, what) =>
          t("readings", "istioPathTerm", { how, what })
        );
        if (read.term) terms.push(read.term);
        else unread.push(verbatim(key, value));
        break;
      }
      case "authority": {
        const read = readStringMatch(value, t, (how, what) =>
          t("readings", "istioHostTerm", { how, what })
        );
        if (read.term) terms.push(read.term);
        else unread.push(verbatim(key, value));
        break;
      }
      case "method": {
        const read = readStringMatch(value, t, (how, what) =>
          t("readings", "istioMethodTerm", { how, what })
        );
        if (read.term) terms.push(read.term);
        else unread.push(verbatim(key, value));
        break;
      }
      case "scheme": {
        const read = readStringMatch(value, t, (how, what) =>
          t("readings", "istioSchemeTerm", { how, what })
        );
        if (read.term) terms.push(read.term);
        else unread.push(verbatim(key, value));
        break;
      }
      case "port": {
        if (typeof value === "number") {
          terms.push(t("readings", "istioPortTerm", { port: value }));
        } else {
          unread.push(verbatim(key, value));
        }
        break;
      }
      case "headers": {
        if (typeof value !== "object" || value === null) {
          unread.push(verbatim(key, value));
          break;
        }
        for (const [header, condition] of Object.entries(
          value as Record<string, unknown>
        )) {
          const read = readStringMatch(condition, t, (how, what) =>
            t("readings", "istioHeaderTerm", { header, how, what })
          );
          if (read.term) terms.push(read.term);
          else unread.push(verbatim(`headers.${header}`, condition));
        }
        break;
      }
      default:
        // queryParams, withoutHeaders, sourceLabels, sourceNamespace,
        // gateways, statPrefix — and whatever Istio adds next.
        unread.push(verbatim(key, value));
    }
  }

  return { terms, unread, refused: null, raw };
}

/** Whether the whole entry was read, which is what the surface may state plainly. */
export function fullyRead(reading: MatchReading): boolean {
  return reading.refused === null && reading.unread.length === 0;
}

/**
 * A rule's `match` list, read as the alternatives it is.
 *
 * An empty or absent list is a rule that takes every request the host has
 * left, which is what a default route is and is stated as such.
 */
export function readMatches(matches: unknown, t: T): MatchReading[] {
  if (!Array.isArray(matches) || matches.length === 0) return [];
  return matches.map((entry) => readMatch(entry, t));
}

/** "path starts with /api, and the x-env header is exactly staging". */
export function describeMatch(reading: MatchReading, t: T): string {
  if (reading.refused) return t("readings", "istioShownBelow");
  if (reading.terms.length === 0) {
    return reading.unread.length > 0
      ? t("readings", "istioShownBelow")
      : t("readings", "istioEveryRequest");
  }
  const said = reading.terms.join(t("readings", "istioAndJoin"));
  return reading.unread.length > 0
    ? t("readings", "istioAndMoreBelow", { said })
    : said;
}
