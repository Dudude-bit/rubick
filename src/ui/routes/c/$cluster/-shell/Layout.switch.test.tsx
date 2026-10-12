import { readFileSync } from "node:fs";
import { Profiler } from "react";
import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { clusterColor } from "@/lib/cluster-identity";
import { renderWithRouter } from "@/test/render";

vi.mock("@/lib/commands", () => ({
  commands: new Proxy(
    {},
    {
      get: (_, name) =>
        name === "then"
          ? undefined
          : async (arg: unknown) => {
              if (name === "focusCluster")
                return arg
                  ? { context: arg, connected_through: "direct" }
                  : null;
              if (name === "connectCluster") {
                if (arg === "acme-prod-eu")
                  throw new Error("deadline has elapsed");
                return { context: arg, connected_through: "direct" };
              }
              if (name === "releaseClusters") return arg;
              if (name === "getClusterOverview")
                return {
                  servedFrom: "watch",
                  counts: { pods: 90 },
                  pods: null,
                  problems: [],
                  problemsTruncated: 0,
                  unconfirmed: [],
                  warnings: [],
                  warningsKnown: true,
                  jobs: null,
                  deployments: null,
                  namespaces: [],
                  nodes: [],
                  nodesKnown: true,
                  unread: [],
                  nextChangeAt: null,
                  metricsAvailable: false,
                };
              if (name === "listNamespaces") return [];
              if (String(name).startsWith("list"))
                return { rows: [], unread: [] };
              return null;
            },
    }
  ),
}));

vi.mock("./PageArea", () => ({ PageArea: () => <p>page</p> }));

const { Layout } = await import("./Layout");
const { ShellVisibility } =
  await import("@/components/settings/ShellVisibility");
const { useClusterStore } = await import("@/stores/clusterStore");
const { useScopeTabStore } = await import("@/stores/scopeTabStore");

const CONTEXTS = ["acme-staging", "acme-prod-eu", "acme-qa"];

/**
 * What one commit put on screen, read the way a person reads the window: the
 * colour each reader shows and whether it says live. A reader left to the
 * global colour fade shows the colour it had in the frame before, which is
 * what WebKit painted for as long as the page under it took to draw.
 */
interface Frame {
  name: string | null;
  accent: string;
  sidebar: string;
  tab: string;
  bar: "live" | "connecting" | "failed" | "not live";
}

function reader() {
  const before = new Map<string, string>();
  const shown = (key: string, element: Element | null, now: string) => {
    const was = before.get(key);
    before.set(key, now);
    return element?.hasAttribute("data-window-cluster") || was === undefined
      ? now
      : was;
  };
  return (root: HTMLElement): Frame => {
    const shell = root.querySelector<HTMLElement>(".h-screen")!;
    const cluster = shell.style.getPropertyValue("--cluster");
    const fill = (element: HTMLElement | null) =>
      element?.style.background === "var(--cluster)"
        ? cluster
        : (element?.getAttribute("aria-label") ?? "none");
    const accent = shell.firstElementChild;
    const sidebar = shell.querySelector<HTMLElement>(
      "aside span[aria-label$='connected'], aside span[aria-label='connecting']"
    );
    const tab = shell.querySelector<HTMLElement>(
      "[role='tab'][data-active='true'] [data-connected]"
    );
    const bar = shell.querySelector("footer")?.textContent ?? "";
    return {
      name:
        shell.querySelector("aside button[aria-haspopup='menu'] .truncate")
          ?.textContent ?? null,
      accent: shown("accent", accent, cluster),
      sidebar: shown("sidebar", sidebar, fill(sidebar)),
      tab: shown("tab", tab, fill(tab)),
      bar: bar.includes("not connected")
        ? "not live"
        : bar.includes("connecting to")
          ? "connecting"
          : bar.includes("connection failed")
            ? "failed"
            : "live",
    };
  };
}

async function mount(at: string) {
  const frames: Frame[] = [];
  const read = reader();
  let root: HTMLElement | null = null;
  const view = await renderWithRouter(
    <Profiler
      id="shell"
      onRender={() => {
        if (root) frames.push(read(root));
      }}
    >
      <ShellVisibility>
        <Layout />
      </ShellVisibility>
    </Profiler>,
    { at }
  );
  root = view.container;
  frames.push(read(root));
  return { frames, root: view.container };
}

/** Every frame from the first that names `context` on, and there is one. */
function from(frames: Frame[], context: string) {
  const first = frames.findIndex((frame) => frame.name === context);
  expect(first).toBeGreaterThanOrEqual(0);
  return frames.slice(first);
}

/** A frame of `context`, live, in its own colour in every reader. */
const liveOn = (context: string): Frame => ({
  name: context,
  accent: clusterColor(context),
  sidebar: clusterColor(context),
  tab: clusterColor(context),
  bar: "live",
});

beforeEach(() => {
  localStorage.clear();
  useClusterStore.setState({
    contexts: CONTEXTS.map((name) => ({ name }) as never),
    contextsKnown: true,
    currentContext: "acme-staging",
    namespaceScope: [],
    currentNamespace: "",
    isConnected: true,
    isLoading: false,
    isAuthenticating: false,
    error: null,
    errorContext: null,
    pendingContext: null,
    lastConnected: "acme-staging",
    wayBack: null,
    live: ["acme-staging"],
    paths: { "acme-staging": "direct" },
    failures: {},
  });
});

describe("the window's cluster, frame by frame", () => {
  /**
   * Live round 26: back to acme-staging from acme-prod-eu's failed connect,
   * the line along the top stayed prod-eu red and the dots grey for 1.4 s
   * under a sidebar already naming acme-staging. Fails if any reader of the
   * window's cluster or its liveness draws a frame in another's state.
   */
  it("draws the cluster turned back to in its colour, live, from the first frame that names it", async () => {
    const { frames } = await mount("/c/acme-staging/pods");
    await act(() => useClusterStore.getState().connect("acme-prod-eu"));
    expect(frames.at(-1)).toEqual({
      name: "acme-prod-eu",
      accent: clusterColor("acme-prod-eu"),
      sidebar: "disconnected",
      tab: "none",
      bar: "failed",
    });

    frames.length = 0;
    await act(() =>
      useClusterStore.getState().connect("acme-staging", { keepRoute: true })
    );

    for (const frame of from(frames, "acme-staging"))
      expect(frame).toEqual(liveOn("acme-staging"));
  });

  /**
   * Live round 26: the first frame after a click on the acme-staging tab
   * named acme-staging over acme-qa's amber dot and accent. Fails if a tab
   * switch draws one cluster's name in another's colour or liveness.
   */
  it("draws a tab switch between two held clusters in one state at every frame", async () => {
    useClusterStore.setState({
      live: ["acme-staging", "acme-qa"],
      paths: { "acme-staging": "direct", "acme-qa": "direct" },
    });
    useScopeTabStore.setState({
      tabs: [
        {
          id: "staging",
          context: "acme-staging",
          namespace: "",
          scope: [],
          href: "/c/acme-staging/pods",
          missing: false,
        },
        {
          id: "qa",
          context: "acme-qa",
          namespace: "",
          scope: [],
          href: "/c/acme-qa/events",
          missing: false,
        },
      ],
      activeId: "staging",
      pendingHref: null,
    });
    const { frames } = await mount("/c/acme-staging/pods");

    for (const [id, context] of [
      ["qa", "acme-qa"],
      ["staging", "acme-staging"],
    ]) {
      frames.length = 0;
      await act(() => useScopeTabStore.getState().activateTab(id));
      for (const frame of from(frames, context))
        expect(frame).toEqual(liveOn(context));
    }
  });

  /**
   * The fade is what kept the cluster left on screen: it cannot finish while
   * the main thread draws the page arrived at. Fails if anything painted in
   * the window's cluster colour is left to the global colour fade.
   */
  it("paints the window's cluster without a fade, wherever it is painted", async () => {
    const { root } = await mount("/c/acme-staging/pods");
    const painted = [...root.querySelectorAll<HTMLElement>("*")].filter(
      (element) =>
        /var\(--cluster\)/.test(element.getAttribute("style") ?? "") ||
        /\(--cluster\)/.test(element.getAttribute("class") ?? "")
    );

    expect(painted.length).toBeGreaterThanOrEqual(4);
    for (const element of painted)
      expect(element.outerHTML).toContain("data-window-cluster");
    const css = readFileSync("src/ui/index.css", "utf8");
    expect(css).toMatch(
      /\[data-window-cluster\]\s*\{\s*transition-property:\s*none;\s*\}/
    );
  });
});
