/**
 * Traefik's `match` is a small language, and this reads the part of it that
 * decides *which host and which path* — nothing else.
 *
 * ``Host(`shop.example.com`) && PathPrefix(`/api`)`` is most of what anybody
 * writes, and it is what lets the page be pivoted by host at all. The rest of
 * the language — `Header`, `Query`, `ClientIP`, `Method`, `HostRegexp`,
 * negation, parenthesised groups — is not paraphrased, because **a wrong
 * paraphrase of a routing rule is worse than the raw string.** A reader who
 * sees the rule as written can check it; a reader told "serves /api" by a
 * parser that quietly dropped `&& Method(`POST`)` cannot.
 *
 * ## What is a fact and what is a guess
 *
 * The one thing that makes partial reading honest is that **a conjunction
 * only ever narrows**. If a rule requires ``Host(`a`)`` and also something
 * this parser does not understand, then every request it matches is still for
 * host `a` — so filing the route under `a` states a fact, not a guess. The
 * term it could not read is kept verbatim in {@link RuleReading.unread} and
 * the surface prints the whole rule beside it.
 *
 * Two things break that and are therefore refused outright, for the whole
 * rule:
 *
 * - **Negation.** `!Host(`a`)` matches everything *except* `a`, so treating
 *   the `Host` term as a requirement inverts the meaning.
 * - **A parenthesised group.** ``Host(`a`) && (PathPrefix(`/x`) ||
 *   PathPrefix(`/y`))`` cannot be split into alternatives without
 *   implementing precedence, and a half-implemented precedence is exactly the
 *   kind of confident wrongness this file exists to avoid.
 *
 * A top-level `||` *is* read, because it needs no precedence: `&&` binds
 * tighter than `||` in Traefik, so the rule is a list of alternatives and
 * each one is an independent set of requirements. ``Host(`a`) || Host(`b`)``
 * is two routes, exactly, and that is the most common non-trivial rule there
 * is.
 */

/** How a path term constrains the request. */
export interface RulePath {
  kind: "prefix" | "exact";
  value: string;
}

/**
 * One alternative of a rule: everything a request must satisfy to take it.
 *
 * `host: null` is a route with no host term at all — a catch-all, which is a
 * real and deliberate configuration and not a parse failure.
 */
export interface RuleClause {
  host: string | null;
  path: RulePath | null;
}

export interface RuleReading {
  /**
   * The rule exactly as written, or `null` where there was no rule text to
   * begin with — an Ingress states its host and path in fields, so there is
   * nothing raw to fall back to and nothing that could be misread.
   */
  raw: string | null;
  /** Every alternative that could be read. Empty when {@link refused} is set. */
  clauses: RuleClause[];
  /**
   * The terms that were not interpreted, verbatim. Non-empty means the
   * surface must show {@link raw} and say it is showing it raw.
   */
  unread: string[];
  /**
   * Why nothing at all could be read, in words a reader can act on. `null`
   * when at least one clause came out.
   */
  refused: string | null;
}

const HOST = new Set(["host"]);
const PREFIX = new Set(["pathprefix"]);
const EXACT = new Set(["path"]);

type Token =
  | { kind: "term"; name: string; args: string[]; raw: string }
  | { kind: "op"; op: "&&" | "||" | "!" };

/**
 * Split a rule into matcher calls and the operators between them, at the top
 * level only.
 *
 * Returns `null` for anything whose shape this file refuses to reason about,
 * which the caller turns into a refusal with a reason.
 */
function tokenize(rule: string): Token[] | null {
  const tokens: Token[] = [];
  let index = 0;

  while (index < rule.length) {
    const char = rule[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === "&" || char === "|") {
      if (rule[index + 1] !== char) return null;
      tokens.push({ kind: "op", op: char === "&" ? "&&" : "||" });
      index += 2;
      continue;
    }

    if (char === "!") {
      tokens.push({ kind: "op", op: "!" });
      index += 1;
      continue;
    }

    // A bare `(` here is a grouped expression rather than a matcher's own
    // argument list: a matcher is only ever reached through its name.
    if (char === "(" || char === ")") return null;

    const name = /^[A-Za-z][A-Za-z0-9]*/.exec(rule.slice(index))?.[0];
    if (!name) return null;
    index += name.length;

    while (index < rule.length && /\s/.test(rule[index])) index += 1;
    if (rule[index] !== "(") return null;

    const args = readArgs(rule, index);
    if (!args) return null;
    tokens.push({
      kind: "term",
      name,
      args: args.values,
      raw: `${name}${rule.slice(index, args.end)}`,
    });
    index = args.end;
  }

  return tokens;
}

/**
 * The argument list starting at `open`, and where it ends.
 *
 * Quoted runs are walked rather than scanned for, so a backtick argument
 * containing a bracket or a comma — a regex, most often — does not end the
 * call early or split into two arguments.
 */
function readArgs(
  rule: string,
  open: number
): { values: string[]; end: number } | null {
  const values: string[] = [];
  let current = "";
  let index = open + 1;
  let depth = 1;

  while (index < rule.length) {
    const char = rule[index];

    if (char === "`" || char === '"' || char === "'") {
      const close = rule.indexOf(char, index + 1);
      if (close === -1) return null;
      current += rule.slice(index + 1, close);
      index = close + 1;
      continue;
    }

    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        if (current.trim() !== "") values.push(current.trim());
        return { values, end: index + 1 };
      }
    }

    if (char === "," && depth === 1) {
      if (current.trim() !== "") values.push(current.trim());
      current = "";
      index += 1;
      continue;
    }

    current += char;
    index += 1;
  }

  return null;
}

/** What one `&&`-joined run of terms requires, or nothing where it requires
 *  two different hosts at once and so can never match. */
function readAlternative(terms: Token[]): {
  clauses: RuleClause[];
  unread: string[];
} {
  const hosts: string[] = [];
  const paths: RulePath[] = [];
  const unread: string[] = [];
  let hostTerms = 0;

  for (const term of terms) {
    if (term.kind !== "term") continue;
    const name = term.name.toLowerCase();

    if (HOST.has(name) && term.args.length > 0) {
      hostTerms += 1;
      // Traefik 2 allowed `Host(`a`, `b`)` and read it as either host.
      hosts.push(...term.args);
      continue;
    }
    if (PREFIX.has(name) && term.args.length === 1) {
      paths.push({ kind: "prefix", value: term.args[0] });
      continue;
    }
    if (EXACT.has(name) && term.args.length === 1) {
      paths.push({ kind: "exact", value: term.args[0] });
      continue;
    }
    unread.push(term.raw);
  }

  // Two separate `Host(...)` terms joined by `&&` require the request to be
  // for two hosts at once. Rather than pick one, the whole run is handed
  // back raw — there is no host this route can honestly be filed under.
  if (hostTerms > 1) {
    return { clauses: [], unread: terms.map((t) => rawOf(t)) };
  }

  // Two path terms narrow each other in a way that depends on the values, and
  // the page has one path column. Both are kept verbatim instead.
  const path = paths.length === 1 ? paths[0] : null;
  if (paths.length > 1) {
    unread.push(...terms.filter(isPathTerm).map((t) => rawOf(t)));
  }

  const clauses: RuleClause[] =
    hosts.length > 0
      ? hosts.map((host) => ({ host, path }))
      : [{ host: null, path }];

  return { clauses, unread };
}

function isPathTerm(token: Token): boolean {
  if (token.kind !== "term") return false;
  const name = token.name.toLowerCase();
  return PREFIX.has(name) || EXACT.has(name);
}

function rawOf(token: Token): string {
  return token.kind === "term" ? token.raw : token.op;
}

/**
 * Read a Traefik match rule as far as it can be read exactly.
 */
export function readRule(rule: string): RuleReading {
  const raw = rule;
  if (rule.trim() === "") {
    return { raw, clauses: [], unread: [], refused: "the rule is empty" };
  }

  const tokens = tokenize(rule);
  if (!tokens) {
    return {
      raw,
      clauses: [],
      unread: [],
      refused: "it is not a plain list of matchers",
    };
  }
  if (tokens.some((token) => token.kind === "op" && token.op === "!")) {
    return {
      raw,
      clauses: [],
      unread: [],
      refused: "it is negated, so a matcher in it is not a requirement",
    };
  }

  const alternatives: Token[][] = [[]];
  for (const token of tokens) {
    if (token.kind === "op" && token.op === "||") {
      alternatives.push([]);
      continue;
    }
    alternatives[alternatives.length - 1].push(token);
  }

  const clauses: RuleClause[] = [];
  const unread: string[] = [];
  for (const alternative of alternatives) {
    if (alternative.length === 0) {
      return {
        raw,
        clauses: [],
        unread: [],
        refused: "it is not a plain list of matchers",
      };
    }
    const read = readAlternative(alternative);
    clauses.push(...read.clauses);
    unread.push(...read.unread);
  }

  if (clauses.length === 0) {
    return {
      raw,
      clauses: [],
      unread: [],
      refused: "no host or path in it could be read",
    };
  }

  return { raw, clauses, unread: [...new Set(unread)], refused: null };
}

/** Whether the whole rule was read, which is what the surface may state plainly. */
export function fullyRead(reading: RuleReading): boolean {
  return reading.refused === null && reading.unread.length === 0;
}

/** "/api", "/api (exact)", or the em dash a route with no path term gets. */
export function describePath(path: RulePath | null): string {
  if (!path) return "any path";
  return path.kind === "exact" ? `${path.value} (exact)` : path.value;
}
