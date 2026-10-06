/**
 * The backend's events, typed from the Rust enum that sends them.
 *
 * `AppEvent` arrives tagged with its channel, so narrowing the generated
 * union by that tag is each listener's payload: a field or a channel renamed
 * on one side no longer compiles on the other.
 */

import type { WatchOp } from "@/generated/types";
import {
  transport,
  type EventChannel,
  type EventPayload,
  type Unlisten,
} from "@/lib/transport";

export type { EventChannel, EventPayload };

/** What a listener is handed: the payload, under the name every listener here reads. */
export type AppEventHandler<P> = (event: { payload: P }) => void;

/** `listen` on one of the backend's channels, with its payload's type. */
export function listenEvent<C extends EventChannel>(
  channel: C,
  handler: AppEventHandler<EventPayload<C>>
): Promise<Unlisten> {
  return transport().listen(channel, (payload) => handler({ payload }));
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

type Watcher = (payload: EventPayload<"resource-event">) => void;
const watchers = new Set<Watcher>();
let shared: Promise<Unlisten> | null = null;

/**
 * Every watch hears one shared listener. Tauri forgets an unlistened
 * callback a round trip before the backend stops sending to it, so a watch
 * with its own listener that left while another's batch was in flight logged
 * "Couldn't find callback id". Leaving the set never reaches Tauri.
 */
export function listenResourceEvents<T>(
  handler: AppEventHandler<ResourceEvent<T>>
): Promise<Unlisten> {
  const watcher: Watcher = (payload) =>
    handler({ payload: payload as unknown as ResourceEvent<T> });
  watchers.add(watcher);
  const registering = (shared ??= transport().listen(
    "resource-event",
    (payload) => {
      for (const each of watchers) each(payload);
    }
  ));
  const release = () => {
    watchers.delete(watcher);
    if (watchers.size > 0 || shared !== registering) return;
    shared = null;
    void registering.then((off) => off());
  };
  return registering.then(
    () => release,
    (error: unknown) => {
      release();
      throw error;
    }
  );
}
