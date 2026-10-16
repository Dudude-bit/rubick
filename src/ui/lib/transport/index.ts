import type { AppEvent } from "@/generated/types";
import { ipcTransport } from "./ipc";

export type TransportStatus = "open" | "connecting" | "unreachable";
export type EventChannel = AppEvent["channel"];
export type EventPayload<C extends EventChannel> = Extract<
  AppEvent,
  { channel: C }
>;
export type Unlisten = () => void;

/**
 * How the window reaches the backend: Tauri IPC on the desktop, a socket to
 * a server later. Everything above it (`commands`, `listenEvent`) is written
 * against this and never against Tauri, so the second one is an adapter and
 * not a rewrite.
 *
 * The contract every adapter keeps, held by `contract.test.ts`: a failure
 * rejects with the backend's own `{ code, message }`, and a listener hears a
 * channel until it is unlistened and not after.
 */
export interface Transport {
  readonly kind: "ipc" | "fake";
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<C extends EventChannel>(
    channel: C,
    onEvent: (payload: EventPayload<C>) => void
  ): Promise<Unlisten>;
  status(): TransportStatus;
  onStatus(listener: (status: TransportStatus) => void): Unlisten;
}

let current: Transport = ipcTransport();

/** Puts another adapter under the app: a fake in a test, a socket in a browser. */
export function setTransport(next: Transport): void {
  current = next;
}

export const transport = (): Transport => current;

/** What the generated command bindings call; see `make gen-entities-tauri`. */
export const invoke = <T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> => current.invoke<T>(command, args);
