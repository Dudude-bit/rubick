// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FileEntry } from "@/lib/container-files";

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
  commands: {
    listContainerFiles: vi.fn(async () => "files-1"),
    filesSubscribed: vi.fn(async () => undefined),
    stopFilesListing: vi.fn(async () => undefined),
  },
}));

import { commands } from "@/lib/commands";
import { useContainerFiles } from "./useContainerFiles";

const TARGET = {
  pod: "web",
  namespace: "shop",
  container: "app",
  path: "/var/log",
  via: null,
  life: "uid-1:0",
};

function rows(from: number, count: number): FileEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `f${from + i}.log`,
    kind: "file",
    mode: "644",
    size: 1,
    modified: null,
    owner: "root",
    group: "root",
    target: null,
  }));
}

function emit(event: string, payload: Record<string, unknown>) {
  for (const handler of listeners[event] ?? []) {
    handler({ payload: { channel: event, stream_id: "files-1", ...payload } });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(listeners)) delete listeners[key];
});

describe("a listing whose batches did not all arrive", () => {
  /** `files-done` says how many rows were sent; ignoring it drew a listing a dropped batch had shortened as the whole directory. */
  it("counts the rows that were sent and never arrived", async () => {
    const { result } = renderHook(() => useContainerFiles(TARGET));
    await waitFor(() =>
      expect(commands.filesSubscribed).toHaveBeenCalledWith("files-1")
    );

    act(() => {
      emit("files-batch", { entries: rows(0, 500) });
      emit("files-batch", { entries: rows(1000, 500) });
      emit("files-done", {
        with: "gnuFind",
        entries: 1500,
        partial: false,
        unreadable: 0,
        elapsed_ms: 40,
      });
    });

    const state = result.current.state;
    expect(state.phase).toBe("done");
    if (state.phase !== "done") return;
    expect(state.entries).toHaveLength(1000);
    expect(state.lost).toBe(500);
  });

  /** Every row arriving is the only case that may claim nothing went missing. */
  it("says nothing was lost when every row arrived", async () => {
    const { result } = renderHook(() => useContainerFiles(TARGET));
    await waitFor(() =>
      expect(commands.filesSubscribed).toHaveBeenCalledWith("files-1")
    );

    act(() => {
      emit("files-batch", { entries: rows(0, 3) });
      emit("files-done", {
        with: "gnuFind",
        entries: 3,
        partial: false,
        unreadable: 0,
        elapsed_ms: 5,
      });
    });

    const state = result.current.state;
    expect(state.phase === "done" && state.lost).toBe(0);
  });
});
