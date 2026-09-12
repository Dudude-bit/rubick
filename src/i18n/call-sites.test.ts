import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { en, type Plural } from "./catalogue";

/**
 * Every `t(section, key, …)` call in `src/`, against the string it names.
 *
 * CLAUDE.md: "Pass a value for every {placeholder}: an unsupplied one renders
 * literally." Nothing enforced it. `readyOfDeclared` was changed from
 * `{declared}` to `{n}` so one vendor could have a plural, and the other
 * vendor's two call sites kept passing `declared` — so every members line on
 * the Scylla page printed the characters `{n}`, through tsc, lint and 2 497
 * tests.
 *
 * **What it checks, and only this:** a call that passes its own non-empty
 * object literal. That is where the values are visible and unambiguous, and
 * it is the shape the regression above had.
 *
 * A call that passes nothing, an empty `{}`, or one that is wrapped by
 * something that substitutes — `parts(t(…), {…})` for a sentence with markup
 * in it, `splitAround(t(…), "{slot}")`, `<Mono text={t(…)} slot="{kind}">` —
 * is skipped. Those split the slots between the two calls: the plural count
 * goes to `t`, the marked-up name to the wrapper, so neither literal is the
 * whole answer. Reading them means following each value into a different
 * shape of wrapper, and a guard that guessed would report the whole app. So
 * would a key held in a variable, or values spread from an object. Narrow
 * and right beats wide and noisy.
 */

/** From the index of an opening bracket, the index just past its match. */
function matchFrom(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}" };
  const close = pairs[text[open]];
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === text[open]) depth++;
    else if (text[i] === close && --depth === 0) return i + 1;
  }
  return -1;
}

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "generated" || name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else if (/\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path))
      out.push(path);
  }
  return out;
}

/** Every `{name}` the string — or every form of the plural — asks for. */
function slotsOf(entry: string | Plural): Set<string> {
  const texts =
    typeof entry === "string"
      ? [entry]
      : Object.values(entry).filter((v): v is string => typeof v === "string");
  return new Set(
    texts.flatMap((t) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))
  );
}

/** The top-level keys of an object literal; null when it cannot be read. */
function keysOf(literal: string): Set<string> | null {
  if (literal.includes("...")) return null;
  const out = new Set<string>();
  let depth = 0;
  for (let i = 0; i < literal.length; i++) {
    const c = literal[i];
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (depth === 1) {
      const m = /^([A-Za-z_]\w*)\s*[:,}]/.exec(literal.slice(i));
      if (m && /[{,]\s*$/.test(literal.slice(0, i))) {
        out.add(m[1]);
        i += m[1].length;
      }
    }
  }
  return out;
}

interface Call {
  file: string;
  section: string;
  key: string;
  given: Set<string>;
  /** The text around the call, where a wrapper's own substitution shows. */
  near: string;
}

function callsIn(file: string, source: string): Call[] {
  const out: Call[] = [];
  const head = /\bt\(\s*"([A-Za-z_]\w*)"\s*,\s*"([A-Za-z_]\w*)"\s*/g;
  for (const m of source.matchAll(head)) {
    const [, section, key] = m;
    const openT = source.lastIndexOf("(", m.index! + 2);
    const afterT = matchFrom(source, openT);
    if (afterT < 0) continue;
    const inner = source.slice(m.index! + m[0].length, afterT - 1).trim();
    if (!inner.startsWith(",")) continue; // no values here; a wrapper's job
    const brace = source.indexOf("{", m.index! + m[0].length);
    const end = brace < 0 ? -1 : matchFrom(source, brace);
    if (end < 0) continue;
    const given = keysOf(source.slice(brace, end));
    // `{}` means the caller deliberately passed none and something else
    // substitutes; only a literal that names values is evidence.
    if (given === null || given.size === 0) continue;
    out.push({
      file,
      section,
      key,
      given,
      // Everything written around the call, for the rule below.
      near: source.slice(Math.max(0, m.index! - 200), end + 800),
    });
  }
  return out;
}

describe("every t() call supplies what its string asks for", () => {
  it("names no placeholder the caller leaves out", () => {
    const missing: string[] = [];
    for (const file of files("src")) {
      for (const call of callsIn(file, readFileSync(file, "utf8"))) {
        const entry = (en as Record<string, Record<string, string | Plural>>)[
          call.section
        ]?.[call.key];
        if (entry === undefined) continue;
        for (const slot of slotsOf(entry)) {
          // Supplied here, or named right beside the call — `parts(…, {names:
          // …})`, `slot="{kind}"`, `.split("{secret}")` all write the slot
          // down within a line or two of it. Not modelling each wrapper is
          // deliberate: this guard errs towards missing a bug rather than
          // towards reporting a working screen.
          const named =
            call.near.includes(`{${slot}}`) ||
            new RegExp(`[{,]\\s*${slot}\\s*[:,}]`).test(call.near);
          if (!call.given.has(slot) && !named) {
            missing.push(
              `${file.replace(/^src\//, "")}: t("${call.section}", "${call.key}") needs {${slot}}`
            );
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  /**
   * A guard that reads nothing passes forever. If a refactor moves calls out
   * of the shape above, this fails and says so instead of going quiet.
   */
  it("reads the calls it is meant to be checking", () => {
    const all = files("src").flatMap((f) =>
      callsIn(f, readFileSync(f, "utf8"))
    );
    expect(all.length).toBeGreaterThan(200);
  });
});
