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

import { forgetRefusals } from "@/lib/refusals";
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
        unconfirmed: [],
        unread: [],
        counts: { pods: 4 },
      };
    },
    list_service_health_inputs: () => ({ rows: [], unread: [] }),
    list_ingress_health_inputs: () => ({ rows: [], unread: [] }),
    list_autoscalers_in: () => ({ rows: [], unread: [] }),
    list_persistent_volume_claims_in: () => ({ rows: [], unread: [] }),
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
      within(screen.getAllByRole("tab")[0]).getByText(/team-checkout/)
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

describe("the picker's footer under a selection of two", () => {
  const two = () =>
    useClusterStore.setState({
      namespaceScope: ["team-checkout", "shop"],
      currentNamespace: "",
    });
  const footer = () => screen.getByText(/namespaces selected/);

  /**
   * Marco's footer read "2 of 4 namespaces" while the Namespaces list held
   * 18: the 4 was the ceiling. Fails if a total is stated with no list to
   * take it from.
   */
  it("states no total when the namespaces cannot be listed", async () => {
    two();
    const { toggle, wait } = await marco();
    await wait(1_000);
    await toggle();

    expect(footer()).toHaveTextContent(
      "2 namespaces selected, up to 4 at once"
    );
    expect(footer()).not.toHaveTextContent(/ of /);
  });

  /**
   * A grant arrives mid-session and the reader asks again from any screen:
   * the picker follows the list. Fails if the picker keeps its refusal, or
   * states a total other than the list's.
   */
  it("takes its total from the list once the reader asks again after a grant", async () => {
    two();
    const { toggle, wait } = await marco();
    await wait(1_000);
    await toggle();
    expect(screen.getByText(/Cannot list namespaces here/)).toBeInTheDocument();

    cluster.namespaces = "listed";
    act(() => forgetRefusals());
    await wait(1_000);

    expect(footer()).toHaveTextContent(
      "2 of 2 namespaces selected, up to 4 at once"
    );
    expect(screen.queryByText(/Cannot list namespaces here/)).toBeNull();
  });

  /**
   * The grant revoked: a list that is refused now is refused, whatever it
   * said before. Fails if the last answer's total stands over a refusal.
   */
  it("drops the total as soon as the list is refused again", async () => {
    cluster.namespaces = "listed";
    two();
    const { toggle, wait } = await marco();
    await wait(1_000);
    await toggle();
    expect(footer()).toHaveTextContent("2 of 2 namespaces selected");

    cluster.namespaces = "refused";
    act(() => forgetRefusals());
    await wait(1_000);

    expect(footer()).not.toHaveTextContent(/ of /);
    expect(screen.getByText(/Cannot list namespaces here/)).toBeInTheDocument();
  });
});
