/**
 * The backend's events, typed from the Rust enum that sends them.
 *
 * `AppEvent` arrives tagged with its channel, so narrowing the generated
 * union by that tag is each listener's payload: a field or a channel renamed
 * on one side no longer compiles on the other.
 */

import {
  listen,
  type EventCallback,
  type UnlistenFn,
} from "@tauri-apps/api/event";
import type { AppEvent, WatchOp } from "@/generated/types";

export type EventChannel = AppEvent["channel"];

export type EventPayload<C extends EventChannel> = Extract<
  AppEvent,
  { channel: C }
>;

/** `listen` on one of the backend's channels, with its payload's type. */
export function listenEvent<C extends EventChannel>(
  channel: C,
  handler: EventCallback<EventPayload<C>>
): Promise<UnlistenFn> {
  return listen<EventPayload<C>>(channel, handler);
}

/**
 * A watch batch with its resources as the subscriber's own type. The backend
 * sends each kind's info struct, which the union cannot name per stream.
 */
export type ResourceEvent<T> = Omit<
  EventPayload<"resource-event">,
  "changes"
> & {
  changes: Array<ResourceChange<T>>;
};

/** One change in a batch; `null` on the resync markers and on `failed`. */
export interface ResourceChange<T> {
  op: WatchOp;
  resource: T | null;
}

export function listenResourceEvents<T>(
  handler: EventCallback<ResourceEvent<T>>
): Promise<UnlistenFn> {
  return listen<ResourceEvent<T>>("resource-event", handler);
}
