// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
    const { result } = renderHook(() => useContainerFiles(TARGET, false));
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
    const { result } = renderHook(() => useContainerFiles(TARGET, false));
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

/**
 * A listing is of one life of a container. Once that life is over the hook
 * keeps what it listed and reads nothing in the container that replaced it.
 */
describe("a listing whose container has been replaced", () => {
  type Props = { target: typeof TARGET | null; held: boolean };
  const listing = (initialProps: Props) =>
    renderHook(({ target, held }: Props) => useContainerFiles(target, held), {
      initialProps,
    });
  const finish = (count: number) =>
    act(() => {
      emit("files-batch", { entries: rows(0, count) });
      emit("files-done", {
        with: "gnuFind",
        entries: count,
        partial: false,
        unreadable: 0,
        elapsed_ms: 5,
      });
    });

  /**
   * Dana's Files tab listed again on every crash-loop cycle: the target went
   * away with the container and came back unchanged. Fails if its return
   * runs the command again, or if the rows it had are thrown away.
   */
  it("keeps the rows and runs nothing when the target comes back held", async () => {
    const { result, rerender } = listing({ target: TARGET, held: false });
    await waitFor(() => expect(commands.filesSubscribed).toHaveBeenCalled());
    finish(3);

    rerender({ target: null, held: false });
    expect(result.current.state.phase).toBe("idle");
    rerender({ target: TARGET, held: true });
    await act(async () => {});

    expect(commands.listContainerFiles).toHaveBeenCalledOnce();
    const state = result.current.state;
    expect(state.phase).toBe("done");
    if (state.phase !== "done") return;
    expect(state.entries).toHaveLength(3);
  });

  /** Fails if a held target nothing was listed for reads, or claims a read is under way. */
  it("is idle, not reading, for a held target it has no rows of", async () => {
    const { result } = listing({ target: TARGET, held: true });
    await act(async () => {});

    expect(commands.listContainerFiles).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe("idle");
  });

  /**
   * The container died under a read: the stream is stopped and no `files-done`
   * will be heard. Fails if the half-read rows come back as a read in flight.
   */
  it("does not come back to a read the container died under", async () => {
    const { result, rerender } = listing({ target: TARGET, held: false });
    await waitFor(() => expect(commands.filesSubscribed).toHaveBeenCalled());
    act(() => emit("files-batch", { entries: rows(0, 2) }));
    expect(result.current.state.phase).toBe("reading");

    rerender({ target: null, held: false });
    rerender({ target: TARGET, held: true });
    await act(async () => {});

    expect(result.current.state.phase).toBe("idle");
    expect(commands.listContainerFiles).toHaveBeenCalledOnce();
  });

  /** The way out: the reader asks, the life is the new one, and it reads. */
  it("reads the new life once the reader asks for it", async () => {
    const { rerender } = listing({ target: TARGET, held: true });
    await act(async () => {});
    expect(commands.listContainerFiles).not.toHaveBeenCalled();

    rerender({ target: { ...TARGET, life: "uid-1:1" }, held: false });
    await waitFor(() =>
      expect(commands.listContainerFiles).toHaveBeenCalledOnce()
    );
  });
});
