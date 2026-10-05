import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const REFUSED = {
  code: "PERMISSION_DENIED",
  message:
    'pods is forbidden: User "system:serviceaccount:team-checkout:marco" cannot list resource "pods" in API group "" at the cluster scope',
};

const cluster = vi.hoisted(() => ({
  namespaces: "refused" as "refused" | "listed",
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    connectCluster: vi.fn(async (context: string) => ({ context })),
    disconnectCluster: vi.fn(async () => undefined),
    saveClusterPreferences: vi.fn(async () => undefined),
    listContexts: vi.fn(async () => []),
    checkNamespaceAccess: vi.fn(async () => [
      { namespace: "team-checkout", allowed: true },
    ]),
    listNamespaces: vi.fn(async () => {
      if (cluster.namespaces === "refused") throw REFUSED;
      return [{ name: "team-checkout" }, { name: "shop" }];
    }),
    getClusterOverview: vi.fn(async (scope: string[] | null) => {
      if (scope === null) throw REFUSED;
      return {
        namespaces: [],
        problems: [{ namespace: "team-checkout" }],
        problemsTruncated: 0,
        counts: { pods: 4 },
      };
    }),
  },
}));

import { commands } from "@/lib/commands";
import { renderWithRouter } from "@/test/render";
import { ScopeTabs } from "./ScopeTabs";
import { useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";
import { useNamespaceRecencyStore } from "@/stores/namespaceRecencyStore";

const wholeClusterAsks = () =>
  vi
    .mocked(commands.getClusterOverview)
    .mock.calls.filter(([scope]) => scope === null).length;

let attempt = 0;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.mocked(commands.getClusterOverview).mockClear();
  localStorage.clear();
  cluster.namespaces = "refused";
  useNamespaceRecencyStore.setState({ recent: {} });
  attempt += 1;
  useClusterStore.setState({
    contexts: [{ name: "acme-staging", namespace: "team-checkout" } as never],
    currentContext: "acme-staging",
    currentNamespace: "team-checkout",
    namespaceScope: ["team-checkout"],
    isConnected: true,
    isLoading: false,
    isAuthenticating: false,
    error: null,
    pendingContext: null,
    connectionAttemptId: attempt,
  });
  useScopeTabStore.setState({
    tabs: [
      {
        id: "a",
        context: "acme-staging",
        namespace: "team-checkout",
        href: "/c/acme-staging",
        missing: false,
      },
    ],
    activeId: "a",
    pendingHref: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function marco() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  await renderWithRouter(<ScopeTabs />, { at: "/c/acme-staging", route: "$" });
  const toggle = () =>
    user.click(
      within(screen.getAllByRole("tab")[0]).getByText("team-checkout")
    );
  const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
  return { toggle, wait };
}

describe("the namespace picker for a reader of one namespace", () => {
  /**
   * Marco cannot list namespaces, and opening the picker asked for the whole
   * cluster's counts every ten to thirty seconds, each refused, each setting
   * off seven refused cluster-wide watches in the backend. Fails if the
   * picker asks for the whole cluster once the namespace list was refused.
   */
  it("asks nothing of the whole cluster when the namespace list was refused", async () => {
    const { toggle, wait } = await marco();
    await wait(1_000);
    await toggle();
    expect(
      screen.getByRole("listbox", { name: "Namespaces" })
    ).toBeInTheDocument();
    await wait(60_000);

    expect(wholeClusterAsks()).toBe(0);
  });

  /**
   * A reader who may list namespaces but not every pod: the counts are asked
   * once, refused, and not again while the connection stands. Fails if a
   * reopened picker, or the minute it stays open, asks again.
   */
  it("asks the whole cluster once per connection when it refuses", async () => {
    cluster.namespaces = "listed";
    const { toggle, wait } = await marco();
    await wait(1_000);
    await toggle();
    await wait(60_000);
    await toggle();
    await wait(1_000);
    await toggle();
    await wait(60_000);

    expect(wholeClusterAsks()).toBe(1);
  });
});
