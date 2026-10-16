import type {
  EventChannel,
  EventPayload,
  Transport,
  TransportStatus,
} from "./index";

type Handler = (args: Record<string, unknown> | undefined) => unknown;

/**
 * An in-memory backend for tests: commands answered by handlers, events
 * emitted by hand. It keeps the same contract as the real adapters, which
 * `contract.test.ts` checks, so a test written against it means something.
 */
export function fakeTransport(handlers: Record<string, Handler> = {}) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const statusListeners = new Set<(status: TransportStatus) => void>();
  let status: TransportStatus = "open";

  const transport: Transport = {
    kind: "fake",
    invoke: async <T>(command: string, args?: Record<string, unknown>) => {
      const handler = handlers[command];
      if (!handler)
        throw { code: "INTERNAL_ERROR", message: `no handler for ${command}` };
      return (await handler(args)) as T;
    },
    listen: async <C extends EventChannel>(
      channel: C,
      onEvent: (payload: EventPayload<C>) => void
    ) => {
      const set = listeners.get(channel) ?? new Set();
      const listener = (payload: unknown) =>
        onEvent(payload as EventPayload<C>);
      set.add(listener);
      listeners.set(channel, set);
      return () => set.delete(listener);
    },
    status: () => status,
    onStatus: (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
  };

  return {
    transport,
    emit: <C extends EventChannel>(payload: EventPayload<C>) =>
      listeners.get(payload.channel)?.forEach((listener) => listener(payload)),
    setStatus: (next: TransportStatus) => {
      status = next;
      statusListeners.forEach((listener) => listener(next));
    },
  };
}
