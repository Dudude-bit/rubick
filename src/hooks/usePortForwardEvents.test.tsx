import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners: Record<
  string,
  Array<(event: { payload: unknown }) => void> | undefined
> = {};

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (event: string, handler: (e: { payload: unknown }) => void) => {
      (listeners[event] ??= []).push(handler);
      return () => {
        listeners[event] = listeners[event]?.filter((h) => h !== handler);
      };
    }
  ),
}));

vi.mock("@/lib/commands", () => ({
  commands: { listPortForwards: vi.fn(async () => []) },
}));

vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { commands } from "@/lib/commands";
import { usePortForwardStore } from "@/stores/portForwardStore";
import { usePortForwardEvents } from "./usePortForwardEvents";

const session = {
  id: "pf-9",
  context: "prod",
  pod: "payments",
  namespace: "shop",
  localPort: 8080,
  remotePort: 80,
  autoReconnect: false,
  createdAt: "2026-09-23T10:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(listeners)) delete listeners[key];
  usePortForwardStore.setState({ sessions: [session] });
});

describe("the forwards list when the event bridge falls behind", () => {
  /** A lag can drop a forward's `stopped`, and the panel went on listing a forward that had died, with a Stop button over nothing. Fails if the lag does not ask the backend again. */
  it("asks the backend again and drops a forward it no longer has", async () => {
    const hook = renderHook(() => usePortForwardEvents());
    await act(async () => {});

    await act(async () => {
      for (const handler of listeners["event-bridge-lagged"] ?? []) {
        handler({ payload: { missed: 1200 } });
      }
    });

    expect(commands.listPortForwards).toHaveBeenCalled();
    expect(usePortForwardStore.getState().sessions).toEqual([]);
    hook.unmount();
  });
});
