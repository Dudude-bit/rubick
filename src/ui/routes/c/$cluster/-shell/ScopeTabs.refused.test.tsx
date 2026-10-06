import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { setTransport, transport } from "@/lib/transport";
import { fakeTransport } from "@/lib/transport/fake";
import { renderWithRouter } from "@/test/render";
import { ScopeTabs } from "./ScopeTabs";
import { useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";
import { useNamespaceRecencyStore } from "@/stores/namespaceRecencyStore";

const REFUSED = {
  code: "PERMISSION_DENIED",
  message:
    'pods is forbidden: User "system:serviceaccount:team-checkout:marco" cannot list resource "pods" in API group "" at the cluster scope',
};

const cluster = { namespaces: "refused" as "refused" | "listed" };

// Behind the real command wrapper, which is what remembers a refusal.
const overviewScopes: Array<string[] | null> = [];
const real = transport();
setTransport(
  fakeTransport({
    connect_cluster: (args) => ({ context: args?.context }),
    disconnect_cluster: () => undefined,
    save_cluster_preferences: () => undefined,
    list_contexts: () => [],
    check_namespace_access: () => [
      { namespace: "team-checkout", allowed: true },
    ],
    list_namespaces: () => {
      if (cluster.namespaces === "refused") throw REFUSED;
      return [{ name: "team-checkout" }, { name: "shop" }];
    },
    get_cluster_overview: (args) => {
      const scope = (args?.scope ?? null) as string[] | null;
      overviewScopes.push(scope);
      if (scope === null) throw REFUSED;
      return {
        namespaces: [],
        problems: [{ namespace: "team-checkout" }],
        problemsTruncated: 0,
        counts: { pods: 4 },
      };
    },
  }).transport
);
afterAll(() => setTransport(real));

const wholeClusterAsks = () =>
  overviewScopes.filter((scope) => scope === null).length;

let attempt = 0;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  overviewScopes.length = 0;
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
