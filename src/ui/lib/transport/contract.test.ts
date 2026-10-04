import { describe, expect, it, vi } from "vite-plus/test";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { errorCode } from "@/lib/error-utils";
import type { AppEvent } from "@/generated/types";
import { fakeTransport } from "./fake";
import { ipcTransport } from "./ipc";
import type { Transport } from "./index";

type Handlers = Record<string, (args?: Record<string, unknown>) => unknown>;
type Rig = { transport: Transport; emit: (payload: AppEvent) => void };

/** The real Tauri adapter over the mocked Tauri API every test runs with. */
function ipcRig(handlers: Handlers): Rig {
  const callbacks = new Map<
    string,
    Set<(event: { payload: unknown }) => void>
  >();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const handler = handlers[command];
    if (!handler) throw { code: "INTERNAL_ERROR", message: command };
    return handler(args as Record<string, unknown>);
  });
  vi.mocked(listen).mockImplementation(async (channel, callback) => {
    const set = callbacks.get(channel) ?? new Set();
    const cb = callback as (event: { payload: unknown }) => void;
    set.add(cb);
    callbacks.set(channel, set);
    return () => set.delete(cb);
  });
  return {
    transport: ipcTransport(),
    emit: (payload) =>
      callbacks.get(payload.channel)?.forEach((cb) => cb({ payload })),
  };
}

const ADAPTERS: Array<{ name: string; rig: (handlers: Handlers) => Rig }> = [
  { name: "IPC", rig: ipcRig },
  { name: "fake", rig: (handlers) => fakeTransport(handlers) },
];

const LAGGED = { channel: "event-bridge-lagged", missed: 3 } as AppEvent;

describe.each(ADAPTERS)("the $name transport", ({ rig }) => {
  /** Without this the second adapter would be a lookalike that answers differently. */
  it("answers a command with what the backend returned", async () => {
    const { transport } = rig({ get_pod: (args) => ({ name: args?.name }) });
    await expect(
      transport.invoke("get_pod", { name: "api-0" })
    ).resolves.toEqual({ name: "api-0" });
  });

  /**
   * `commands` turns a rejection into a message and reads `errorCode` off it;
   * an adapter that wrapped or stringified the backend's error would leave
   * every refusal reading as an unknown failure.
   */
  it("rejects with the backend's own code and message", async () => {
    const { transport } = rig({
      get_pod: () => {
        throw { code: "PERMISSION_DENIED", message: "pods is forbidden" };
      },
    });
    const failure = await transport.invoke("get_pod").catch((e) => e);
    expect(errorCode(failure)).toBe("PERMISSION_DENIED");
  });

  /** A listener that kept hearing after it let go would update an unmounted screen. */
  it("delivers a channel to its listener until it lets go", async () => {
    const { transport, emit } = rig({});
    const heard: unknown[] = [];
    const stop = await transport.listen("event-bridge-lagged", (payload) =>
      heard.push(payload)
    );
    emit(LAGGED);
    stop();
    emit(LAGGED);
    expect(heard).toEqual([LAGGED]);
  });

  /** A transport that started out unreachable would show every screen as down. */
  it("starts out open", () => {
    expect(rig({}).transport.status()).toBe("open");
  });
});
