/**
 * What the cluster refused on this connection. A refusal is a verdict on who
 * asks, so a refused read is answered from here rather than asked again on
 * every poll and every page visit, until {@link KEPT_FOR} passes, a read of
 * the same resource answers, or the connection or credentials change.
 * Imports nothing that reaches `commands` or `clusterStore`, which both use it.
 */

import { useMemo } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { create } from "zustand";

let connectionOf: () => number = () => 0;

/** How one connection is told from the next, handed over by `clusterStore`. */
export function followConnections(current: () => number): void {
  connectionOf = current;
}

export function currentConnection(): number {
  return connectionOf();
}

/**
 * How long a refused read is answered from here. A webhook timeout or a grant
 * still propagating refuses for seconds; at a list's two-second poll this is
 * one request where there would be sixty.
 */
export const KEPT_FOR = 120_000;

interface Refused {
  connection: number;
  error: unknown;
  /** When the cluster said it, which is the last time it was asked. */
  at: number;
  /** The resource the cluster named in refusing, as {@link stemOf} spells it. */
  of: string | null;
  /** Whether another read of {@link of} answering lets it go; once per {@link KEPT_FOR}. */
  healable: boolean;
}

const useRefusals = create<{
  reads: ReadonlyMap<string, Refused>;
  forgotten: number;
}>(() => ({ reads: new Map(), forgotten: 0 }));

/** A read by what it asks: the command and its arguments, or `null` for arguments that do not print. */
export function readOf(
  command: string,
  args: readonly unknown[]
): string | null {
  try {
    return `${command} ${JSON.stringify(args)}`;
  } catch {
    return null;
  }
}

/** Commands that only read the cluster; asking one again cannot change what it would do. */
export function isRead(command: string): boolean {
  return /^(list|get|detect|read)[A-Z]/.test(command);
}

const isAction = (read: string) => read.startsWith(`${MAY} `);

const kept = (read: string, refused: Refused, now: number) =>
  isAction(read) || now - refused.at < KEPT_FOR;

/** The refusal this read got on this connection, if it got one and still keeps it. */
export function refusalOf(read: string): unknown {
  const refused = useRefusals.getState().reads.get(read);
  return refused?.connection === currentConnection() &&
    kept(read, refused, Date.now())
    ? refused.error
    : undefined;
}

/** "Pods", "pod" and "pods" are one resource; "ingresses" and "Ingress" too. */
function stemOf(word: string): string {
  const lower = word.toLowerCase();
  if (lower.endsWith("sses")) return lower.slice(0, -2);
  if (lower.endsWith("ies")) return `${lower.slice(0, -3)}y`;
  if (lower.endsWith("s") && !lower.endsWith("ss")) return lower.slice(0, -1);
  return lower;
}

function wordsOf(error: unknown): string {
  const said: string[] = [];
  for (let at = error, depth = 0; at != null && depth < 4; depth++) {
    said.push(
      typeof at === "string"
        ? at
        : String((at as { message?: unknown }).message ?? "")
    );
    at = at instanceof Error ? at.cause : undefined;
  }
  return said.join(" ");
}

/** The resource a refusal names in the cluster's own words: `cannot list resource "pods"`, or `deployments.apps is forbidden`. */
function refusedResource(error: unknown): string | null {
  const said = wordsOf(error);
  const named =
    /cannot \w+ resource "([^"]+)"/.exec(said) ??
    /([a-z0-9/-]+)(?:\.[a-z0-9.-]+)?(?: "[^"]*")? is forbidden/.exec(said);
  return named ? stemOf(named[1]) : null;
}

/** Every resource a read can be about: each run of words in its command's name, and each word among its arguments, so `listPodRows` and `listResourceTable("Pod")` both read pods. */
function resourcesOf(command: string, args: readonly unknown[]): Set<string> {
  const words = command.match(/[A-Z][a-z0-9]*/g) ?? [];
  const named = new Set<string>();
  words.forEach((_, from) => {
    for (let to = from + 1; to <= words.length; to++)
      named.add(stemOf(words.slice(from, to).join("")));
  });
  for (const arg of args.flatMap((arg) =>
    arg !== null && typeof arg === "object" ? Object.values(arg) : [arg]
  ))
    if (typeof arg === "string") named.add(stemOf(arg));
  return named;
}

const lettingGo = new Set<(errors: readonly unknown[]) => void>();
let healedAt = new Map<string, { connection: number; at: number }>();

/** Drops the kept reads `which` picks and tells whoever shows their refusals to ask again. */
function letGo(which: (read: string, refused: Refused) => boolean): string[] {
  const reads = new Map(useRefusals.getState().reads);
  const dropped = [...reads].filter(([read, refused]) => which(read, refused));
  if (dropped.length === 0) return [];
  for (const [read] of dropped) reads.delete(read);
  useRefusals.setState({ reads });
  const errors = dropped.map(([, refused]) => refused.error);
  for (const listener of lettingGo) listener(errors);
  return dropped.map(([read]) => read);
}

/**
 * A read answered: the refusals of its resource kept from before it was asked
 * are let go. Once per {@link KEPT_FOR} each, or a role that lists pods in one
 * namespace and not another would be one 403 per poll.
 */
export function noteAnswer(
  command: string,
  args: readonly unknown[],
  askedAt: number,
  connection: number
): void {
  const { reads } = useRefusals.getState();
  if (reads.size === 0 || connection !== currentConnection()) return;
  const about = resourcesOf(command, args);
  const healed = letGo(
    (read, refused) =>
      refused.connection === connection &&
      refused.healable &&
      refused.of !== null &&
      refused.at <= askedAt &&
      !isAction(read) &&
      about.has(refused.of)
  );
  for (const read of healed) healedAt.set(read, { connection, at: Date.now() });
}

/** Asks `client` again for every query showing a refusal let go of here; returns the unsubscribe. */
export function askAgainWhenLetGo(client: QueryClient): () => void {
  const listener = (errors: readonly unknown[]) =>
    void client.invalidateQueries({
      predicate: (query) =>
        errors.some((error) => carries(query.state.error, error)),
    });
  lettingGo.add(listener);
  return () => lettingGo.delete(listener);
}

/**
 * Keeps a read's refusal for the connection it was asked on: one that
 * answers after a reconnect is not this one's.
 */
export function noteRefusal(
  read: string,
  error: unknown,
  connection: number
): void {
  if (connection !== currentConnection()) return;
  if (refusalOf(read) !== undefined) return;
  const reads = new Map(useRefusals.getState().reads);
  for (const [key, refused] of reads)
    if (refused.connection !== connection) reads.delete(key);
  const now = Date.now();
  const healed = healedAt.get(read);
  const refused: Refused = {
    connection,
    error,
    at: now,
    of: refusedResource(error),
    healable: !(
      healed?.connection === connection && now - healed.at < KEPT_FOR
    ),
  };
  useRefusals.setState({ reads: reads.set(read, refused) });
  // Let go on time, so a screen showing it asks again with nothing polling it.
  if (!isAction(read))
    setTimeout(() => letGo((_, entry) => entry === refused), KEPT_FOR);
}

/**
 * When the cluster refused the read `error` answered on this connection, or
 * `null` where no kept refusal is that one. A kept refusal answers every later
 * ask itself, so the time a screen re-read it from here is not this.
 */
export function useRefusedAt(error: unknown): number | null {
  return useRefusals((s) => {
    if (error == null) return null;
    const connection = currentConnection();
    for (const refused of s.reads.values())
      if (refused.connection === connection && carries(error, refused.error))
        return refused.at;
    return null;
  });
}

/** `error` is `kept`, or wraps it. */
function carries(error: unknown, kept: unknown): boolean {
  for (let at = error, depth = 0; at != null && depth < 4; depth++) {
    if (at === kept) return true;
    at = at instanceof Error ? at.cause : undefined;
  }
  return false;
}

let askingAgain = false;

/** Runs `ask` with the kept refusals of the reads it starts dropped, so the cluster answers them afresh. */
export function askAgain<T>(ask: () => T): T {
  askingAgain = true;
  try {
    return ask();
  } finally {
    askingAgain = false;
  }
}

/** A wrapper that runs its first `ask` through {@link askAgain} and every later one as it is. */
export function askedAgainFirst() {
  let first = true;
  return <T>(ask: () => T): T => {
    if (!first) return ask();
    first = false;
    return askAgain(ask);
  };
}

/** Drops `read`'s kept refusal when it is started inside {@link askAgain}. */
export function forgetIfAskedAgain(read: string): void {
  const { reads } = useRefusals.getState();
  if (!askingAgain || !reads.has(read)) return;
  const kept = new Map(reads);
  kept.delete(read);
  useRefusals.setState({ reads: kept });
}

/** The command an action's refusal is kept under: the authorizer's "may not", which no read asks again. */
export const MAY = "may";

/**
 * Rights may have changed, by the reader's word or a credential renewal:
 * every refused read is asked once more. A refused action is kept until its
 * access review, keyed on {@link useRightsAsked}, answers again and
 * {@link settleRefusal} replaces it: let go here, its mark went out and came
 * back a second later with every renewal.
 */
export function forgetRefusals(): void {
  healedAt = new Map();
  useRefusals.setState((s) => ({
    reads: new Map([...s.reads].filter(([read]) => isAction(read))),
    forgotten: s.forgotten + 1,
  }));
}

/** The authorizer answered about `read` again: its refusal is kept where it repeats it and dropped where it does not. */
export function settleRefusal(
  read: string,
  refused: boolean,
  error: unknown,
  connection: number
): void {
  if (refused) return noteRefusal(read, error, connection);
  const { reads } = useRefusals.getState();
  if (!reads.has(read)) return;
  const kept = new Map(reads);
  kept.delete(read);
  useRefusals.setState({ reads: kept });
}

/**
 * How many times the reader said their rights may have changed. Every
 * answer about rights keys on it, so the sidebar's locks, the picker's
 * offers and the access reviews are asked again with the refused read.
 */
export function useRightsAsked(): number {
  return useRefusals((s) => s.forgotten);
}

/** Whether this read was refused on `connection`, for a screen that decides on it. */
export function useRefusedOn(
  connection: number,
  command: string,
  args: readonly unknown[]
): boolean {
  const read = readOf(command, args);
  return useRefusals((s) => {
    const refused = read === null ? undefined : s.reads.get(read);
    return refused !== undefined && refused.connection === connection;
  });
}

/** Which of `reads` were refused on `connection`, for a screen deciding on several at once. */
export function useRefusedAmong(
  connection: number,
  reads: readonly string[]
): ReadonlySet<string> {
  const refused = useRefusals((s) =>
    reads
      .filter((read) => {
        const refused = s.reads.get(read);
        return refused !== undefined && refused.connection === connection;
      })
      .join("\n")
  );
  return useMemo(() => new Set(refused ? refused.split("\n") : []), [refused]);
}

/** Every read refused on `connection`, for rows a screen cannot name up front. */
export function useRefusedReads(connection: number): ReadonlySet<string> {
  const refused = useRefusals((s) =>
    [...s.reads]
      .filter(([, refused]) => refused.connection === connection)
      .map(([read]) => read)
      .join("\n")
  );
  return useMemo(() => new Set(refused ? refused.split("\n") : []), [refused]);
}

let told: { connection: number; reads: Set<string> } = {
  connection: -1,
  reads: new Set(),
};

/**
 * Whether a refusal of `read` is news to the log: the first time on this
 * connection. The screen says every refusal in its own words, so the log
 * needs each one once, not once per poll or per page visit.
 */
export function firstTelling(read: string): boolean {
  const connection = currentConnection();
  if (told.connection !== connection) told = { connection, reads: new Set() };
  if (told.reads.has(read)) return false;
  told.reads.add(read);
  return true;
}
