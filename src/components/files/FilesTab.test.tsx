import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { PodInfo } from "@/generated/types";
import type { FileEntry } from "@/lib/container-files";
import type { ListingState } from "./useContainerFiles";

const listing = vi.fn<() => ListingState>();
const stop = vi.fn();
const reload = vi.fn();

vi.mock("./useContainerFiles", () => ({
  useContainerFiles: () => ({ state: listing(), stop, reload }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

// jsdom measures every box as zero, and a virtualiser with no height draws
// no rows; the rows are what these tests read.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 26,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 26,
        size: 26,
      })),
    scrollToIndex: () => {},
    measureElement: () => {},
  }),
}));

const readContainerFile = vi.fn();
vi.mock("@/lib/commands", () => ({
  commands: {
    readContainerFile: (...args: unknown[]) => readContainerFile(...args),
    downloadContainerFile: vi.fn(),
  },
}));

const { FilesTab } = await import("./FilesTab");

function pod(over: Partial<PodInfo> = {}): PodInfo {
  return {
    name: "crash-demo",
    namespace: "k8s-gui-test",
    uid: "uid-1",
    status: {
      phase: "Running",
      display: "Running",
      ready: true,
      conditions: [],
      message: null,
      reason: null,
    },
    nodeName: null,
    podIp: null,
    hostIp: null,
    containers: [
      {
        name: "app",
        image: "gcr.io/distroless/static",
        ready: true,
        started: true,
        phase: "app",
        state: { type: "running" },
        lastTerminated: null,
        restartCount: 3,
        ports: [],
        env: [],
        envFrom: [],
      },
    ],
    initContainers: [],
    labels: {},
    annotations: {},
    createdAt: null,
    restartCount: 3,
    lastRestartAt: null,
    cpuRequests: null,
    cpuLimits: null,
    memoryRequests: null,
    memoryLimits: null,
    ownerReferences: [],
    volumes: [
      {
        name: "config",
        source: "ConfigMap",
        refs: [{ kind: "ConfigMap", name: "demo-config" }],
        mounts: [
          { container: "app", path: "/etc/app", readOnly: true, subPath: null },
        ],
      },
    ],
    serviceAccountName: null,
    ...over,
  } as PodInfo;
}

function wrap(node: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>
  );
}

const done = (entries: FileEntry[]) =>
  ({
    phase: "done",
    entries,
    with: "gnuFind",
    elapsedMs: 300,
    at: Date.now(),
    stopped: false,
  }) as ListingState;

beforeEach(() => {
  listing.mockReset();
  stop.mockReset();
  reload.mockReset();
  readContainerFile.mockReset();
});

describe("FilesTab", () => {
  /** The listing starts where the pod's mounts are, and a row under a mount says so. */
  it("lists from the first mount and tags rows with the mount they come from", () => {
    listing.mockReturnValue(
      done([
        {
          name: "app.conf",
          kind: "file",
          mode: "644",
          size: 1229,
          modified: null,
          owner: "root",
          group: "root",
          target: null,
        },
        {
          name: "conf.d",
          kind: "dir",
          mode: "755",
          size: 4096,
          modified: null,
          owner: "root",
          group: "root",
          target: null,
        },
      ])
    );
    wrap(
      <FilesTab
        pod={pod()}
        via={null}
        onDebug={() => {}}
        onStopVia={() => {}}
      />
    );
    expect(
      screen.getByRole("grid", { name: "Files in /etc/app" })
    ).toBeInTheDocument();
    expect(screen.getByText("app.conf")).toBeInTheDocument();
    expect(screen.getAllByText("from demo-config").length).toBeGreaterThan(0);
    expect(
      screen.getByText(/read via find \(GNU\) · 2 entries/)
    ).toBeInTheDocument();
  });

  /** A tool that is not there is never an empty folder. */
  it("says the image has nothing to list with, and offers the two ways out", async () => {
    const onDebug = vi.fn();
    listing.mockReturnValue({
      phase: "failed",
      entries: [],
      reason: "noTools",
      message:
        "find, sh were each executed directly in the container and none exists",
      exitCode: 127,
      stderr: "",
      tried: ["find", "sh"],
    });
    wrap(
      <FilesTab pod={pod()} via={null} onDebug={onDebug} onStopVia={() => {}} />
    );
    expect(
      screen.getByText("The image has nothing to list files with")
    ).toBeInTheDocument();
    expect(screen.getByText(/find, sh were each executed/)).toBeInTheDocument();
    expect(screen.queryByText(/is empty/)).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Open through a debug container" })
    );
    expect(onDebug).toHaveBeenCalledTimes(1);

    await userEvent.click(
      screen.getByRole("button", { name: "Read the pod's mounts instead" })
    );
    expect(screen.getByText("/etc/app")).toBeInTheDocument();
    expect(screen.getByText(/ConfigMap demo-config/)).toBeInTheDocument();
  });

  it("says an empty directory is empty only once the tool has said so", () => {
    listing.mockReturnValue(done([]));
    wrap(
      <FilesTab
        pod={pod()}
        via={null}
        onDebug={() => {}}
        onStopVia={() => {}}
      />
    );
    expect(
      screen.getByText(
        "/etc/app is empty: the tool ran and found nothing in it."
      )
    ).toBeInTheDocument();
  });

  it("does not exec into a container that is not running", () => {
    listing.mockReturnValue({ phase: "idle" });
    const stopped = pod();
    stopped.containers[0].state = {
      type: "waiting",
      reason: "CrashLoopBackOff",
    };
    wrap(
      <FilesTab
        pod={stopped}
        via={null}
        onDebug={() => {}}
        onStopVia={() => {}}
      />
    );
    expect(screen.getByText(/Container app is waiting/)).toBeInTheDocument();
  });

  /** A listing through a debug container is a different reading and the tab says so. */
  it("names the debug container it reads through", () => {
    listing.mockReturnValue(done([]));
    wrap(
      <FilesTab
        pod={pod()}
        via={{ container: "debugger-x7k2", root: "/proc/1/root" }}
        onDebug={() => {}}
        onStopVia={() => {}}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      /through debug container debugger-x7k2/
    );
  });

  /** A binary file gets a sentence with the number that decided it, not a wall of glyphs. */
  it("refuses to preview a binary and says why", async () => {
    listing.mockReturnValue(
      done([
        {
          name: "core.1842",
          kind: "file",
          mode: "600",
          size: 96 * 1024 * 1024,
          modified: null,
          owner: "app",
          group: "app",
          target: null,
        },
      ])
    );
    readContainerFile.mockResolvedValue({
      state: "preview",
      preview: {
        bytesRead: 1024 * 1024,
        truncated: true,
        binary: true,
        nonTextShare: 0.31,
        text: null,
      },
    });
    wrap(
      <FilesTab
        pod={pod()}
        via={null}
        onDebug={() => {}}
        onStopVia={() => {}}
      />
    );
    await userEvent.click(screen.getByText("core.1842"));
    expect(
      await screen.findByText(/No preview for a binary file/)
    ).toBeInTheDocument();
    expect(screen.getByText(/31% non-text bytes/)).toBeInTheDocument();
  });
});
