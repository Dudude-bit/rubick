import type { ReactElement } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { PodInfo } from "@/generated/types";
import type { FileEntry } from "@/lib/container-files";
import type { ListingState } from "./useContainerFiles";
import { useLocaleStore } from "@/stores/localeStore";

const listing = vi.fn<() => ListingState>();
const stop = vi.fn();
const reload = vi.fn();
const listed = vi.fn();

vi.mock("./useContainerFiles", () => ({
  useContainerFiles: (target: unknown) => {
    listed(target);
    return { state: listing(), stop, reload };
  },
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
const containerWorkingDir = vi.fn();
vi.mock("@/lib/commands", () => ({
  commands: {
    readContainerFile: (...args: unknown[]) => readContainerFile(...args),
    containerWorkingDir: (...args: unknown[]) => containerWorkingDir(...args),
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
        projections: [],
      },
    ],
    serviceAccountName: null,
    ...over,
  } as PodInfo;
}

/** Drawn once the tab has asked the container where it works. */
async function wrap(node: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>
  );
  await waitFor(() =>
    expect(screen.queryByText(/where it works/)).not.toBeInTheDocument()
  );
  return {
    ...view,
    rerender: (next: ReactElement) =>
      view.rerender(
        <QueryClientProvider client={client}>{next}</QueryClientProvider>
      ),
  };
}

const done = (
  entries: FileEntry[],
  over: Partial<Extract<ListingState, { phase: "done" }>> = {}
): ListingState => ({
  phase: "done",
  entries,
  with: "gnuFind",
  elapsedMs: 300,
  at: Date.now(),
  stopped: false,
  partial: false,
  unreadable: 0,
  lost: 0,
  ...over,
});

const file = (name: string, over: Partial<FileEntry> = {}): FileEntry => ({
  name,
  kind: "file",
  mode: "644",
  size: 1229,
  modified: null,
  owner: "root",
  group: "root",
  target: null,
  ...over,
});

beforeEach(() => {
  listing.mockReset();
  stop.mockReset();
  reload.mockReset();
  listed.mockReset();
  readContainerFile.mockReset();
  containerWorkingDir.mockReset();
  containerWorkingDir.mockResolvedValue(null);
});

describe("FilesTab", () => {
  /** The listing starts where the pod's mounts are, and a row under a mount says so. */
  it("lists from the first mount and tags rows with the mount they come from", async () => {
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
    await wrap(
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

  /**
   * Lena's pod, Files at /var/run/secrets/kubernetes.io/serviceaccount: every
   * row said "from kube-root-ca.crt", the token and the namespace included,
   * though the volume projects a token, that ConfigMap's ca.crt only, and the
   * namespace from the downward API. Fails if a file is tagged with a source
   * the spec says did not write it, or `..data`, which holds them all, is
   * tagged with one.
   */
  /**
   * Marco's breadcrumb read "/ / var / run": the root crumb is a slash and a
   * separator followed it. Fails if a separator comes back after the root.
   */
  it("draws the path from the root with one slash between names", async () => {
    listing.mockReturnValue(done([file("..data", { kind: "dir" })]));
    await wrap(
      <FilesTab
        pod={pod()}
        via={null}
        onDebug={() => {}}
        onStopVia={() => {}}
      />
    );
    expect(
      screen
        .getAllByTestId("files-crumb")
        .map((crumb) => crumb.textContent)
        .join("")
    ).toBe("/etc/app");
  });

  it("tags each file in the service account volume with the source that wrote it", async () => {
    const at = "/var/run/secrets/kubernetes.io/serviceaccount";
    containerWorkingDir.mockResolvedValue(at);
    listing.mockReturnValue(
      done([
        file("..2026_10_06_21_20_13.2911439", { kind: "dir", size: 100 }),
        file("..data", {
          kind: "symlink",
          target: "..2026_10_06_21_20_13.2911439",
        }),
        file("ca.crt", { kind: "symlink", target: "..data/ca.crt" }),
        file("namespace", { kind: "symlink", target: "..data/namespace" }),
        file("token", { kind: "symlink", target: "..data/token" }),
      ])
    );
    await wrap(
      <FilesTab
        pod={pod({
          volumes: [
            {
              name: "kube-api-access-6xk2p",
              source: "projected",
              refs: [{ kind: "ConfigMap", name: "kube-root-ca.crt" }],
              mounts: [
                { container: "app", path: at, readOnly: true, subPath: null },
              ],
              projections: [
                {
                  source: "serviceAccountToken",
                  object: null,
                  paths: ["token"],
                },
                {
                  source: "configMap",
                  object: { kind: "ConfigMap", name: "kube-root-ca.crt" },
                  paths: ["ca.crt"],
                },
                { source: "downwardAPI", object: null, paths: ["namespace"] },
              ],
            },
          ],
        })}
        via={null}
        onDebug={() => {}}
        onStopVia={() => {}}
      />
    );
    const tagOf = (name: string) =>
      within(
        screen
          .getAllByRole("row")
          .find((row) => row.textContent?.startsWith(name))!
      ).getByText(/^from /).textContent;

    expect(tagOf("token")).toBe("from serviceAccountToken");
    expect(tagOf("ca.crt")).toBe("from kube-root-ca.crt");
    expect(tagOf("namespace")).toBe("from downwardAPI");
    expect(tagOf("..data")).toBe("from kube-api-access-6xk2p");
  });

  /**
   * The owner's pods all opened on the service account token directory, the
   * first mount, while the app lives in its working directory. Fails if the
   * tab opens anywhere else, or the mounts stop being one click away.
   */
  it("opens where the container works, with its mounts one click away", async () => {
    containerWorkingDir.mockResolvedValue("/srv/app");
    listing.mockReturnValue(done([file("server.js")]));
    await wrap(
      <FilesTab
        pod={pod({
          volumes: [
            {
              name: "kube-api-access-6xk2p",
              source: "projected",
              refs: [],
              mounts: [
                {
                  container: "app",
                  path: "/var/run/secrets/kubernetes.io/serviceaccount",
                  readOnly: true,
                  subPath: null,
                },
              ],
              projections: [],
            },
            ...pod().volumes,
          ],
        })}
        via={null}
        onDebug={() => {}}
        onStopVia={() => {}}
      />
    );
    expect(containerWorkingDir).toHaveBeenCalledWith(
      "crash-demo",
      "k8s-gui-test",
      "app"
    );
    expect(
      screen.getByRole("grid", { name: "Files in /srv/app" })
    ).toBeInTheDocument();
    expect(listed).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "/srv/app" })
    );
    expect(
      screen.queryByRole("button", {
        name: "/var/run/secrets/kubernetes.io/serviceaccount",
      })
    ).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "/etc/app" }));
    expect(
      screen.getByRole("grid", { name: "Files in /etc/app" })
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "/srv/app" }));
    expect(
      screen.getByRole("grid", { name: "Files in /srv/app" })
    ).toBeInTheDocument();
  });

  /** Fails if a path is drawn, or a listing started, before the container has said where it works. */
  it("says it is asking where the container works until it answers", async () => {
    containerWorkingDir.mockReturnValue(new Promise(() => {}));
    listing.mockReturnValue({ phase: "idle" });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <FilesTab
          pod={pod()}
          via={null}
          onDebug={() => {}}
          onStopVia={() => {}}
        />
      </QueryClientProvider>
    );
    expect(
      await screen.findByText("Asking app where it works…")
    ).toBeInTheDocument();
    expect(screen.queryAllByTestId("files-crumb")).toHaveLength(0);
    expect(screen.queryByRole("grid")).toBeNull();
    expect(listed).toHaveBeenCalled();
    expect(listed.mock.calls.every(([target]) => target === null)).toBe(true);
  });

  /**
   * Lena's Files tab read "5 записей · 0.2 с": a decimal point in Russian.
   * Fails if the seconds skip the reader's decimal mark.
   */
  it("writes the seconds a listing took in the reader's decimal mark", async () => {
    useLocaleStore.setState({ choice: "ru" });
    try {
      listing.mockReturnValue(done([file("app.conf")], { elapsedMs: 240 }));
      await wrap(
        <FilesTab
          pod={pod()}
          via={null}
          onDebug={() => {}}
          onStopVia={() => {}}
        />
      );
      expect(screen.getByText(/· 1 запись · 0,2 с/)).toBeInTheDocument();
    } finally {
      useLocaleStore.setState({ choice: null });
    }
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
    await wrap(
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
    const mounts = screen.getByRole("list");
    expect(within(mounts).getByText("/etc/app")).toBeInTheDocument();
    expect(
      within(mounts).getByText(/ConfigMap demo-config/)
    ).toBeInTheDocument();
  });

  /**
   * The way in for an image with no tools is an ephemeral container. Fails
   * if it stays live for a reader the cluster will not let add one.
   */
  it("greys the debug way in where the review refuses it", async () => {
    const onDebug = vi.fn();
    listing.mockReturnValue({
      phase: "failed",
      entries: [],
      reason: "noTools",
      message: "none exists",
      exitCode: 127,
      stderr: "",
      tried: ["find", "sh"],
    });
    await wrap(
      <TooltipProvider>
        <FilesTab
          pod={pod()}
          via={null}
          onDebug={onDebug}
          onStopVia={() => {}}
          debugDenied="Your access does not allow this: the cluster answers no to kubectl auth can-i patch pods/ephemeralcontainers -n shop."
        />
      </TooltipProvider>
    );
    const viaDebug = screen.getByRole("button", {
      name: "Open through a debug container",
    });
    expect(viaDebug).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(viaDebug);
    expect(onDebug).not.toHaveBeenCalled();
  });

  it("says an empty directory is empty only once the tool has said so", async () => {
    listing.mockReturnValue(done([]));
    await wrap(
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

  it("does not exec into a container that is not running", async () => {
    listing.mockReturnValue({ phase: "idle" });
    const stopped = pod();
    stopped.containers[0].state = {
      type: "waiting",
      reason: "CrashLoopBackOff",
    };
    await wrap(
      <FilesTab
        pod={stopped}
        via={null}
        onDebug={() => {}}
        onStopVia={() => {}}
      />
    );
    expect(screen.getByText(/Container app is waiting/)).toBeInTheDocument();
  });

  /**
   * Marco's stopped worker showed "filter 0 names" and a full path though
   * nothing was or would be read. Fails if either is drawn before there is
   * a listing, or the filter before there are names to filter.
   */
  it("draws no path before a listing and no filter before there are names", async () => {
    listing.mockReturnValue({ phase: "idle" });
    const stopped = pod();
    stopped.containers[0].state = {
      type: "waiting",
      reason: "CrashLoopBackOff",
    };
    const view = await wrap(
      <FilesTab
        pod={stopped}
        via={null}
        onDebug={() => {}}
        onStopVia={() => {}}
      />
    );
    expect(screen.queryAllByTestId("files-crumb")).toHaveLength(0);
    expect(screen.queryByRole("textbox")).toBeNull();
    view.unmount();

    listing.mockReturnValue({ phase: "reading", entries: [], startedAt: 0 });
    const reading = await wrap(
      <FilesTab
        pod={pod()}
        via={null}
        onDebug={() => {}}
        onStopVia={() => {}}
      />
    );
    expect(screen.getAllByTestId("files-crumb").length).toBeGreaterThan(0);
    expect(screen.queryByRole("textbox")).toBeNull();
    reading.unmount();

    listing.mockReturnValue(done([file("app.conf")]));
    await wrap(
      <FilesTab
        pod={pod()}
        via={null}
        onDebug={() => {}}
        onStopVia={() => {}}
      />
    );
    expect(
      screen.getByRole("textbox", { name: "filter 1 name…" })
    ).toBeInTheDocument();
  });

  /**
   * The same tab told Marco a debug container could read the stopped
   * container's files while Debug was greyed for his account. Fails if the
   * way in is suggested to an account the cluster refuses it, or withheld
   * from one it allows.
   */
  it("offers a debug container for a stopped container only where it may be added", async () => {
    listing.mockReturnValue({ phase: "idle" });
    const stopped = pod();
    stopped.containers[0].state = {
      type: "waiting",
      reason: "CrashLoopBackOff",
    };
    const onDebug = vi.fn();
    const refused = await wrap(
      <FilesTab
        pod={stopped}
        via={null}
        onDebug={onDebug}
        onStopVia={() => {}}
        debugDenied="Your access does not allow this: the cluster answers no to kubectl auth can-i patch pods/ephemeralcontainers -n shop."
      />
    );
    expect(
      screen.queryByRole("button", { name: "Open through a debug container" })
    ).toBeNull();
    expect(document.body.textContent).not.toContain("debug container");
    await userEvent.click(
      screen.getByRole("button", { name: "Read the pod's mounts instead" })
    );
    expect(screen.getByRole("list")).toHaveTextContent("/etc/app");
    refused.unmount();

    await wrap(
      <FilesTab
        pod={stopped}
        via={null}
        onDebug={onDebug}
        onStopVia={() => {}}
      />
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Open through a debug container" })
    );
    expect(onDebug).toHaveBeenCalledWith("app");
  });

  /** A listing through a debug container is a different reading and the tab says so. */
  it("names the debug container it reads through", async () => {
    listing.mockReturnValue(done([]));
    await wrap(
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
        lossy: false,
        text: null,
      },
    });
    await wrap(
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

  /**
   * Issue #178: a file over the old 100 MiB cap was refused outright. It is
   * asked about now, and the file dialog opens only after the answer. Would
   * break if the confirmation went away, or if the cap fell back under it.
   */
  it("asks before a download that will take minutes, and not before a small one", async () => {
    listing.mockReturnValue(
      done([
        {
          name: "core.1842",
          kind: "file",
          mode: "600",
          size: 300 * 1024 * 1024,
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
        bytesRead: 1024,
        truncated: true,
        binary: true,
        nonTextShare: 0.5,
        lossy: false,
        text: null,
      },
    });
    const { save } = await import("@tauri-apps/plugin-dialog");
    await wrap(
      <FilesTab
        pod={pod()}
        via={null}
        onDebug={() => {}}
        onStopVia={() => {}}
      />
    );
    await userEvent.click(screen.getByText("core.1842"));
    await userEvent.click(
      await screen.findByRole("button", { name: "Download" })
    );
    expect(
      await screen.findByText(/Download core.1842 \(300.0Mi\)\?/)
    ).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getAllByRole("button", { name: "Download" }).at(-1)!
    );
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  });

  /**
   * "Reading, and nothing has arrived yet" and "the tool finished and found
   * nothing" are two different answers. Only the second one is emptiness, and
   * a listing that streams its rows in spends every read in the first.
   */
  it("does not call a directory empty while the rows are still arriving", async () => {
    listing.mockReturnValue({
      phase: "reading",
      entries: [],
      startedAt: Date.now(),
    });
    await wrap(
      <FilesTab
        pod={pod()}
        via={null}
        onDebug={() => {}}
        onStopVia={() => {}}
      />
    );
    expect(screen.queryByText(/is empty/)).toBeNull();
    expect(screen.getByText(/reading · 0 entries so far/)).toBeInTheDocument();
  });

  /**
   * Every line the tool printed was refused by the parser. The directory is
   * not empty — nobody has any idea what is in it, and saying "empty" here
   * is the same lie as answering a 403 with an empty list.
   */
  it("says what is in a directory is unknown when no line could be read", async () => {
    listing.mockReturnValue(done([], { unreadable: 4 }));
    await wrap(
      <FilesTab
        pod={pod()}
        via={null}
        onDebug={() => {}}
        onStopVia={() => {}}
      />
    );
    expect(screen.queryByText(/is empty/)).toBeNull();
    expect(
      screen.getByText(/none of them could be read, so what is in here/)
    ).toBeInTheDocument();
  });

  /** A batch the event bridge dropped left a short listing drawn as the whole directory, or an empty one called empty. */
  it("says rows were lost on the way instead of calling the listing whole", async () => {
    listing.mockReturnValue(done([file("a.log")], { lost: 500 }));
    const view = await wrap(
      <FilesTab
        pod={pod()}
        via={null}
        onDebug={() => {}}
        onStopVia={() => {}}
      />
    );
    expect(
      screen.getByText(/500 rows were lost on the way/)
    ).toBeInTheDocument();

    listing.mockReturnValue(done([], { lost: 300 }));
    view.rerender(
      <FilesTab
        pod={pod()}
        via={null}
        onDebug={() => {}}
        onStopVia={() => {}}
      />
    );
    expect(screen.queryByText(/is empty/)).toBeNull();
    expect(
      screen.getByText(/300 rows and none of them arrived/)
    ).toBeInTheDocument();
  });

  /**
   * The bytes were repaired to be printable. Saying "text" and showing the
   * repair is telling the reader they are looking at the file when they are
   * looking at something we made.
   */
  it("says a preview was repaired rather than presenting it as the file", async () => {
    listing.mockReturnValue(done([file("greeting.bin", { size: 12 })]));
    readContainerFile.mockResolvedValue({
      state: "preview",
      preview: {
        bytesRead: 12,
        truncated: false,
        binary: false,
        nonTextShare: 0.0,
        lossy: true,
        text: "hello\uFFFDworld",
      },
    });
    await wrap(
      <FilesTab
        pod={pod()}
        via={null}
        onDebug={() => {}}
        onStopVia={() => {}}
      />
    );
    await userEvent.click(screen.getByText("greeting.bin"));
    expect(
      await screen.findByText(/not valid UTF-8. What is below is a repair/)
    ).toBeInTheDocument();
  });

  /**
   * The line count sits beside the file's whole size, and the preview stopped
   * at the cap — so a bare "8 lines" claims a count of a file nobody read to
   * the end of.
   */
  it("counts the lines it read as a floor when the preview was cut short", async () => {
    listing.mockReturnValue(done([file("app.log", { size: 4_000_000 })]));
    readContainerFile.mockResolvedValue({
      state: "preview",
      preview: {
        bytesRead: 512 * 1024,
        truncated: true,
        binary: false,
        nonTextShare: 0.0,
        lossy: false,
        text: "one\ntwo\nthree",
      },
    });
    await wrap(
      <FilesTab
        pod={pod()}
        via={null}
        onDebug={() => {}}
        onStopVia={() => {}}
      />
    );
    await userEvent.click(screen.getByText("app.log"));
    expect(await screen.findByText(/3 lines read of more/)).toBeInTheDocument();
    expect(screen.queryByText(/· 3 lines$/)).toBeNull();
  });

  /**
   * The busybox rung's `exit 2` is our own guard firing on a directory the
   * container may not open. Drawn as "the listing did not finish: 2" over
   * the apiserver's doubled boilerplate, it told the reader nothing; and the
   * one thing that would work — a debug container — was not offered.
   */
  it("names a directory it could not open and offers the way in", async () => {
    const onDebug = vi.fn();
    listing.mockReturnValue({
      phase: "failed",
      entries: [],
      reason: "unopenable",
      message: "",
      exitCode: null,
      stderr: "",
      tried: [],
    });
    await wrap(
      <FilesTab pod={pod()} via={null} onDebug={onDebug} onStopVia={() => {}} />
    );
    expect(
      screen.getByText(/\/etc\/app could not be opened/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/did not finish/)).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Open through a debug container" })
    );
    expect(onDebug).toHaveBeenCalledTimes(1);
  });

  /**
   * The preview execs into the container. Holding ArrowDown down a directory
   * opened one exec session per keypress, all but the last for a row nobody
   * ever looked at.
   */
  it("does not exec for a row the arrow keys only passed through", async () => {
    listing.mockReturnValue(
      done([file("a.conf"), file("b.conf"), file("c.conf")])
    );
    readContainerFile.mockResolvedValue({
      state: "preview",
      preview: {
        bytesRead: 4,
        truncated: false,
        binary: false,
        nonTextShare: 0,
        lossy: false,
        text: "hi",
      },
    });
    await wrap(
      <FilesTab
        pod={pod()}
        via={null}
        onDebug={() => {}}
        onStopVia={() => {}}
      />
    );
    const grid = screen.getByRole("grid");
    grid.focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(readContainerFile).not.toHaveBeenCalled();
    await waitFor(() => expect(readContainerFile).toHaveBeenCalledTimes(1));
    expect(readContainerFile.mock.calls[0][3]).toBe("/etc/app/c.conf");
  });

  /**
   * `life` is `uid:container:restarts`, so switching the strip changes it
   * too — and comparing it to the current one announced "app has restarted
   * since this listing" about a container that had not restarted at all.
   */
  it("does not call a container switch a restart", async () => {
    listing.mockReturnValue(done([file("app.conf")]));
    const two = pod();
    two.containers.push({
      ...two.containers[0],
      name: "sidecar",
      phase: "sidecar",
      restartCount: 0,
    });
    await wrap(
      <FilesTab pod={two} via={null} onDebug={() => {}} onStopVia={() => {}} />
    );
    await userEvent.click(screen.getByRole("tab", { name: "sidecar" }));
    expect(screen.queryByText(/has restarted since/)).toBeNull();
  });
});
