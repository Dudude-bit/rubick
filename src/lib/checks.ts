/**
 * A hypothesis, tested from where the pod stands, and what its answer means.
 *
 * The backend returns facts: which tool answered, what it printed, how it
 * exited, and where it ran. Everything a person reads is composed here, at
 * render, from those facts: an outcome stored in a cache never carries a
 * sentence in one language.
 */

import type { CheckOutcome } from "@/generated/types";

/** The image a copy of the pod runs when its own has no tool for the check. */
export const DEFAULT_CHECK_IMAGE = "busybox:1.36";

export interface HostPort {
  host: string;
  port: number;
}

/** `host:port`, or `[v6]:port`, or nothing. */
export function parseHostPort(text: string): HostPort | null {
  const trimmed = text.trim();
  const bracketed = /^\[([^\]]+)\]:(\d{1,5})$/.exec(trimmed);
  const plain = /^([^\s:]+):(\d{1,5})$/.exec(trimmed);
  const match = bracketed ?? plain;
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  return { host: match[1], port };
}

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6 = /\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{1,4}\b/gi;

/**
 * The addresses a resolver printed, whichever resolver it was.
 *
 * `nslookup` opens with the resolver it asked (`Server:` and an `Address:`
 * ending in `#53` or `:53`) before the answer. Those two lines name the
 * nameserver, not the name, and reading them as the answer told a person
 * their name resolved when the resolver had just said it did not.
 */
export function addressesIn(stdout: string): string[] {
  const answer = stdout
    .split("\n")
    .filter((line) => !/^Server:/i.test(line))
    .filter((line) => !/^Address:.*(#53|:53)\s*$/i.test(line))
    .join("\n");
  const found = new Set<string>();
  for (const match of answer.matchAll(IPV4)) found.add(match[0]);
  for (const match of answer.matchAll(IPV6)) found.add(match[0]);
  return [...found];
}

export type Verdict =
  | { says: "resolved"; addresses: string[] }
  | { says: "notResolved" }
  | { says: "connected" }
  | { says: "refused" }
  | { says: "noTool"; tried: string[] };

/** What the outcome means, as a key the catalogue turns into words. */
export function verdictOf(kind: "dns" | "tcp", outcome: CheckOutcome): Verdict {
  if (outcome.toolMissing) return { says: "noTool", tried: outcome.tried };
  if (kind === "dns") {
    const addresses = addressesIn(outcome.stdout);
    // `nslookup` exits 0 with "can't resolve" in its output on busybox, so
    // the exit code alone is not the answer; an address is.
    return outcome.ok && addresses.length > 0
      ? { says: "resolved", addresses }
      : { says: "notResolved" };
  }
  return outcome.ok ? { says: "connected" } : { says: "refused" };
}
