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
  type Transport,
  type Unlisten,
} from "@/lib/transport";

export type { EventChannel, EventPayload };

/** What a listener is handed: the payload, under the name every listener here reads. */
export type AppEventHandler<P> = (event: { payload: P }) => void;

type Heard = (payload: unknown) => void;
type Channels = WeakMap<
  Transport,
  Map<EventChannel, { heard: Set<Heard>; ready: Promise<Unlisten> }>
>;
let channels: Channels = new WeakMap();

/** For tests, whose mocked `listen` starts each test with nobody registered. */
export function forgetChannels(): void {
  channels = new WeakMap();
}

/**
 * `listen` on one of the backend's channels, with its payload's type.
 *
 * One Tauri listener per channel for the window's life, shared by every
 * caller: Tauri forgets an unlistened callback a round trip before the
 * backend stops sending to it, so leaving while an event was in flight
 * logged "Couldn't find callback id". Leaving only leaves the set.
 */
export function listenEvent<C extends EventChannel>(
  channel: C,
  handler: AppEventHandler<EventPayload<C>>
): Promise<Unlisten> {
  const via = transport();
  let open = channels.get(via);
  if (!open) channels.set(via, (open = new Map()));
  let shared = open.get(channel);
  if (!shared) {
    const heard = new Set<Heard>();
    const ready = via.listen(channel, (payload) => {
      for (const each of heard) {
        try {
          each(payload);
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
      }
    });
    const registering = { heard, ready };
    const table = open;
    ready.catch(() => {
      if (table.get(channel) === registering) table.delete(channel);
    });
    open.set(channel, (shared = registering));
  }
  const { heard, ready } = shared;
  const mine: Heard = (payload) =>
    handler({ payload: payload as EventPayload<C> });
  heard.add(mine);
  return ready.then(
    () => () => {
      heard.delete(mine);
    },
    (error: unknown) => {
      heard.delete(mine);
      throw error;
    }
  );
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

/** Every watch's batches, from the one shared `resource-event` listener. */
export function listenResourceEvents<T>(
  handler: AppEventHandler<ResourceEvent<T>>
): Promise<Unlisten> {
  return listenEvent(
    "resource-event",
    handler as unknown as AppEventHandler<EventPayload<"resource-event">>
  );
}
