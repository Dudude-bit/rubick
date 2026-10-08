/**
 * What the cluster refused on this connection. A refusal is a verdict on who
 * asks, so a refused read is answered from here until the next connect
 * instead of asking the cluster again on every poll and every page visit.
 * Imports nothing that reaches `commands` or `clusterStore`, which both use it.
 */

import { useMemo } from "react";
import { create } from "zustand";

let connectionOf: () => number = () => 0;

/** How one connection is told from the next, handed over by `clusterStore`. */
export function followConnections(current: () => number): void {
  connectionOf = current;
}

export function currentConnection(): number {
  return connectionOf();
}

interface Refused {
  connection: number;
  error: unknown;
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

/** The refusal this read got on this connection, if it got one. */
export function refusalOf(read: string): unknown {
  const refused = useRefusals.getState().reads.get(read);
  return refused?.connection === currentConnection()
    ? refused.error
    : undefined;
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
  useRefusals.setState({ reads: reads.set(read, { connection, error }) });
}

/** The reader says their rights may have changed: every refused read is asked once more. */
export function forgetRefusals(): void {
  useRefusals.setState((s) => ({
    reads: new Map(),
    forgotten: s.forgotten + 1,
  }));
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
