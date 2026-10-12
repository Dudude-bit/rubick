import { act } from "@testing-library/react";
import { focusManager } from "@tanstack/react-query";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { renderWithRouter } from "@/test/render";

const reads = vi.hoisted(() => ({ overview: [] as unknown[] }));

vi.mock("@/lib/commands", () => ({
  commands: new Proxy(
    {},
    {
      get: (_, name) =>
        name === "then"
          ? undefined
          : async (scope: unknown) => {
              if (name === "getClusterOverview") {
                reads.overview.push(scope);
                return {
                  servedFrom: "watch",
                  counts: { pods: reads.overview.length },
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
              }
              if (name === "listNamespaces") return [];
              if (String(name).startsWith("list"))
                return { rows: [], unread: [] };
              return null;
            },
    }
  ),
}));

vi.mock("./PageArea", () => ({ PageArea: () => <p>big-pull</p> }));

const { Layout } = await import("./Layout");
const { ShellVisibility } =
  await import("@/components/settings/ShellVisibility");
const { useClusterStore } = await import("@/stores/clusterStore");
const { useSettingsStore } = await import("@/stores/settingsStore");
const { useWindowActivity } = await import("@/lib/window-activity");

beforeEach(() => {
  reads.overview = [];
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: [
      "setTimeout",
      "setInterval",
      "clearTimeout",
      "clearInterval",
      "Date",
    ],
  });
  focusManager.setFocused(true);
  useWindowActivity.setState({ visible: true, focused: true });
  useClusterStore.setState({
    isConnected: true,
    currentContext: "prod",
    namespaceScope: ["shop"],
  });
});

afterEach(() => {
  useSettingsStore.setState({ open: false });
  vi.useRealTimers();
});

/** A minute of a reader at work on a page that is not the Overview: a touch every two seconds. */
async function aMinute() {
  const before = reads.overview.length;
  for (let second = 0; second < 60; second += 2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      useWindowActivity.setState({ interactionAt: Date.now() });
    });
  return reads.overview.slice(before);
}

const shell = () =>
  renderWithRouter(
    <ShellVisibility>
      <Layout />
    </ShellVisibility>,
    { at: "/c/prod/deployments/shop/big-pull" }
  );

describe("the shell's overview reads", () => {
  /**
   * Sam counted 110 overview reads in 544 s and asked who polls it behind a
   * Deployment page. The sidebar's counts, its Overview badge and the status
   * bar all count from one answer for the window's scope. Fails if any of
   * them asks for an answer of its own, or asks faster than every ten seconds.
   */
  it("reads the overview once every ten seconds behind another page, one answer for every count drawn from it", async () => {
    await shell();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    const asked = await aMinute();

    expect(asked.length).toBeGreaterThanOrEqual(5);
    expect(asked.length).toBeLessThanOrEqual(6);
    expect(new Set(asked.map((scope) => JSON.stringify(scope)))).toEqual(
      new Set([JSON.stringify(["shop"])])
    );
  });

  /** Fails if Settings, which covers the whole window, leaves the shell under it asking. */
  it("reads nothing while Settings covers the shell", async () => {
    await shell();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      useSettingsStore.setState({ open: true });
    });

    expect(await aMinute()).toEqual([]);
  });
});
