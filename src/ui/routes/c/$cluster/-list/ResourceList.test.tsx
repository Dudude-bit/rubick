/**
 * What the list says when the read did not work.
 *
 * "The scope holds none of these" and "the app could not find out" are
 * different sentences with different fixes, and the table's empty state is
 * only ever entitled to the first one.
 */

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { type ReactElement } from "react";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@/components/ui/table-features";

const openExternal = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/open-external", () => ({ openExternal }));

const store = vi.hoisted(() => ({
  state: {
    currentNamespace: "default",
    namespaceScope: [] as string[],
    isConnected: true,
    currentContext: null as string | null,
    contexts: [] as Array<{ name: string; namespace: string | null }>,
  },
}));

vi.mock("@/stores/clusterStore", () => ({
  useClusterStore: vi.fn(<T,>(selector?: (s: typeof store.state) => T) =>
    typeof selector === "function" ? selector(store.state) : store.state
  ),
}));

import {
  ScreenShareProvider,
  useScreenSections,
} from "@/components/share/screen-share";
import type { PlacedSection } from "@/lib/report-parts";
import { commands } from "@/lib/commands";
import { ResourceList } from "./ResourceList";
import type { Scoped, UnreadNamespace } from "@/generated/types";
import { SCOPE_PICKER_OPEN, SLOW_READ_MS } from "@/lib/read-deadline";
import { renderWithRouter } from "@/test/render";

interface Item {
  name: string;
  namespace: string;
}

const columns: ColumnDef<Item>[] = [{ accessorKey: "name", header: "Name" }];

const draw = (ui: ReactElement, client?: QueryClient) =>
  renderWithRouter(ui, { client, at: "/c/prod/pods", route: "/c/$cluster/$" });

const drawRerenderable = draw;

const list = (props: {
  data?: Item[];
  error?: Error | null;
  isLoading?: boolean;
  unread?: UnreadNamespace[];
  queryKey?: string[];
  queryFn?: () => Promise<Scoped<Item>>;
}) =>
  draw(
    <ResourceList<Item>
      title="Pods"
      columns={columns}
      emptyStateLabel="Pods"
      {...props}
    />
  );

describe("a list whose rows come from outside", () => {
  /**
   * The regression this exists for. A page that fetches its own rows — one
   * with `usePodsWithMetrics` behind it, or a workload list — hands
   * `ResourceList` an array either way, so a scope the token cannot read and a
   * scope with nothing in it arrived here identical. Every such page told the
   * reader their cluster had no pods.
   */
  it("says the read failed rather than that the scope is empty", async () => {
    await list({ data: [], error: new Error("connection reset by peer") });

    expect(screen.getByText(/Could not read Pods in this scope/)).toBeVisible();
    expect(screen.getByText(/connection reset/)).toBeVisible();
  });

  /**
   * A refusal is not a failure. "Could not read" describes something broken
   * and invites a retry that will be refused in exactly the same way, which
   * is how an ordinary RBAC boundary came to read as a fault in the app.
   */
  it("says a refusal is a refusal", async () => {
    store.state.namespaceScope = ["shop"];
    await list({ data: [], error: new Error("pods is forbidden: RBAC") });
    store.state.namespaceScope = [];

    expect(
      screen.getByText(/do not have permission to list these/)
    ).toBeVisible();
    expect(screen.queryByText(/Could not read/)).not.toBeInTheDocument();
    // The cluster's own words stay: they name the resource and the user,
    // which is what somebody takes to whoever grants the rights.
    expect(screen.getByText(/forbidden/)).toBeVisible();
  });

  /**
   * A namespace-only Role is refused every cluster-wide list, and the only
   * way past it is a namespace it may read. Fails if the refusal in "All
   * namespaces" stops pointing at the picker that takes a typed name.
   */
  it("points a refusal across the whole cluster at the namespace picker", async () => {
    const opened = vi.fn();
    window.addEventListener(SCOPE_PICKER_OPEN, opened);
    await list({ data: [], error: new Error("pods is forbidden: RBAC") });

    await userEvent.click(
      screen.getByRole("button", { name: "Choose a namespace" })
    );
    window.removeEventListener(SCOPE_PICKER_OPEN, opened);
    expect(opened).toHaveBeenCalledOnce();
  });

  /**
   * Under All namespaces a namespace-only reader is refused every list, and
   * the page said "You do not have permission to list these" above pods
   * they list every day in their own namespace.
   */
  it("says a list refused across the cluster is not refused everywhere, and where it can be listed", async () => {
    store.state.currentContext = "prod";
    store.state.contexts = [{ name: "prod", namespace: "team-checkout" }];
    const asked = vi
      .spyOn(commands, "checkListAccess")
      .mockImplementation(async (queries, namespaces) =>
        queries.map((query) => ({
          resource: query.resource,
          allowed: namespaces[0] === "team-checkout",
        }))
      );
    await list({ data: [], error: new Error("pods is forbidden: RBAC") });

    expect(
      screen.getByText(/across the whole cluster was refused/)
    ).toBeVisible();
    expect(screen.queryByText(/do not have permission/)).toBeNull();
    expect(
      await screen.findByText("You can list them in team-checkout.")
    ).toBeVisible();
    expect(asked).toHaveBeenCalledWith(
      [{ group: "", resource: "pods", namespaced: true }],
      ["team-checkout"]
    );
    asked.mockRestore();
    store.state.currentContext = null;
    store.state.contexts = [];
  });

  /**
   * Nodes are one list whatever namespace is chosen, so the page sent a
   * reader refused them to a picker that could not change the answer. Fails
   * if a cluster-scoped kind is offered the namespace picker.
   */
  it("offers no namespace to a cluster-scoped kind refused across the cluster", async () => {
    await draw(
      <ResourceList<Item>
        title="Nodes"
        columns={columns}
        emptyStateLabel="nodes"
        data={[]}
        error={new Error("nodes is forbidden: RBAC")}
      />
    );

    expect(
      screen.getByText(/do not have permission to list these/)
    ).toBeVisible();
    expect(screen.queryByText(/may still answer/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Choose a namespace" })
    ).toBeNull();
  });

  /** No error, no rows: the scope really is empty, and says so. */
  it("draws the empty state when nothing failed", async () => {
    await list({ data: [] });

    expect(screen.queryByText(/Could not read/)).not.toBeInTheDocument();
    expect(screen.getByText(/No resources of this type/)).toBeVisible();
  });

  /**
   * The same rule the internal query already followed: a failed re-read over
   * rows that are still on screen is not worth throwing the page away for.
   */
  it("keeps the rows it has when a re-read fails", async () => {
    await list({
      data: [{ name: "api-7bcd", namespace: "default" }],
      error: new Error("connection reset"),
    });

    expect(screen.getByText("api-7bcd")).toBeVisible();
    expect(screen.queryByText(/Could not read/)).not.toBeInTheDocument();
  });
});

describe("the count beside the title", () => {
  const counted = () =>
    within(
      screen.getByRole("heading", { name: "Pods" }).parentElement!
    ).queryByTestId("section-count")?.textContent ?? null;

  /**
   * Under All namespaces a namespace-only reader saw "Pods 0" above the
   * sentence saying the list was refused. Fails if a refused read is counted.
   */
  it("draws no number beside a list it was refused", async () => {
    await list({ data: [], error: new Error("pods is forbidden: RBAC") });

    expect(screen.getByText(/forbidden/)).toBeVisible();
    expect(counted()).toBeNull();
  });

  /** Fails if a read that broke is counted as an empty one. */
  it("draws no number beside a list that could not be read", async () => {
    await list({ data: [], error: new Error("connection reset by peer") });

    expect(counted()).toBeNull();
  });

  /** Fails if the first read, still running, is counted as nothing found. */
  it("draws no number while the first read is still running", async () => {
    await list({ data: [], isLoading: true });

    expect(counted()).toBeNull();
  });

  /** Fails if the rule above swallowed a real zero too. */
  it("counts a list that answered with nothing as 0", async () => {
    await list({ data: [] });

    expect(counted()).toBe("0");
  });
});

describe("a scope some of whose namespaces did not answer", () => {
  const refused: UnreadNamespace = {
    namespace: "staging",
    code: "PERMISSION_DENIED",
    message: 'pods is forbidden: User "narrow" cannot list pods in staging',
  };

  afterEach(() => {
    store.state.namespaceScope = [];
  });

  /**
   * The defect the scoped read exists for: one namespace refused, the other
   * answered, and the page drew the answer as the whole selection. The
   * refused one is named with the cluster's words, and the header carries no
   * count, because the rows are not the scope's total.
   */
  it("names the namespace it could not read beside the rows of the rest", async () => {
    store.state.namespaceScope = ["prod", "staging"];
    await list({
      data: [{ name: "api", namespace: "prod" }],
      unread: [refused],
    });

    expect(screen.getByText("api")).toBeVisible();
    expect(
      screen.getByText("Could not read pods in staging.")
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The cluster refused: pods is forbidden/)
    ).toBeVisible();
    expect(screen.queryByText("1")).toBeNull();
  });

  /**
   * "None in the current scope" over a scope with an unread namespace is the
   * third state collapsed into the second. The empty table speaks only for
   * the namespaces that answered.
   */
  it("says none only of the namespaces that answered", async () => {
    store.state.namespaceScope = ["prod", "staging"];
    await list({
      queryKey: ["pods", "prod,staging"],
      queryFn: async () => ({ rows: [], unread: [refused] }),
    });

    expect(await screen.findByText("No pods in prod.")).toBeVisible();
    expect(screen.queryByText(/No resources of this type/)).toBeNull();
    expect(screen.getByText("Could not read pods in staging.")).toBeVisible();
  });

  /**
   * The header dropped its count beside an unread namespace, and the footer
   * went on printing "1 pod" under it, the same number stated as the total.
   */
  it("does not call the rows a total in the footer either", async () => {
    store.state.namespaceScope = ["prod", "staging"];
    await list({
      data: [{ name: "api", namespace: "prod" }],
      unread: [refused],
    });

    expect(
      screen.getByText("1 Pod, from the namespaces that answered")
    ).toBeInTheDocument();
    expect(screen.queryByText("1 Pod")).toBeNull();
  });

  /**
   * While a new scope is read, the last scope's answer stands in. Its unread
   * namespaces are not this scope's, and a box naming one of them sat under
   * a selection that did not contain it.
   */
  it("does not carry the last scope's unread namespaces into the next", async () => {
    store.state.namespaceScope = ["prod", "staging"];
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const page = (queryKey: string[], answer: () => Promise<Scoped<Item>>) => (
      <ResourceList<Item>
        title="Pods"
        columns={columns}
        emptyStateLabel="Pods"
        queryKey={queryKey}
        queryFn={answer}
      />
    );
    const { rerender } = await drawRerenderable(
      page(["pods", "prod,staging"], async () => ({
        rows: [{ name: "api", namespace: "prod" }],
        unread: [refused],
      })),
      client
    );
    expect(
      await screen.findByText("Could not read pods in staging.")
    ).toBeVisible();

    store.state.namespaceScope = ["dev"];
    rerender(page(["pods", "dev"], () => new Promise(() => {})));
    expect(screen.queryByText("Could not read pods in staging.")).toBeNull();
  });

  /**
   * A re-read under a live watch that timed out in one namespace. The watch
   * still streams that namespace, and its rows are current in the cache;
   * the answer took them away and called the namespace unread, and the
   * watch went on sending changes to rows the page no longer had.
   */
  it("keeps a watched namespace's rows when a re-read misses it", async () => {
    store.state.namespaceScope = ["prod", "staging"];
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    const key = ["pods", "prod,staging"];
    client.setQueryData<Scoped<Item>>(key, {
      rows: [
        { name: "api", namespace: "prod" },
        { name: "worker", namespace: "staging" },
      ],
      unread: [],
    });
    const answer = vi.fn(async () => ({
      rows: [
        { name: "api", namespace: "prod" },
        { name: "api-2", namespace: "prod" },
      ],
      unread: [{ ...refused, code: "READ_DEADLINE" }],
    }));
    await draw(
      <ResourceList<Item>
        title="Pods"
        columns={columns}
        emptyStateLabel="Pods"
        queryKey={key}
        queryFn={answer}
        live
      />,
      client
    );
    expect(await screen.findByText("worker")).toBeVisible();
    // What a delete from the page does next.
    await act(() => client.invalidateQueries({ queryKey: key }));
    expect(await screen.findByText("api-2")).toBeVisible();
    expect(screen.getByText("worker")).toBeVisible();
    expect(screen.queryByText("Could not read pods in staging.")).toBeNull();
  });
});

describe("a read on a large cluster", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A deadline is not a fault. "Could not read" invites the retry that just
   * ran out of time; what shortens the next read is a narrower question,
   * so that is what comes first, and the number in the sentence is the one
   * the backend applied.
   */
  it("ends in words that offer the narrower question before a retry", async () => {
    const opened = vi.fn();
    window.addEventListener(SCOPE_PICKER_OPEN, opened);
    await list({
      data: [],
      error: new Error(
        "Tauri command 'list_pods' failed: READ_DEADLINE: the cluster did not answer within 60 s"
      ),
    });

    expect(
      screen.getByText(/Reading pods in .* did not finish within 60 s/)
    ).toBeVisible();
    expect(screen.queryByText(/Could not read/)).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: /Pick one namespace/ })
    );
    expect(opened).toHaveBeenCalledTimes(1);
    window.removeEventListener(SCOPE_PICKER_OPEN, opened);
  });

  /**
   * The eternal skeleton. Nothing here had a deadline on either side, so a
   * slow list was a shape that never stopped; past the threshold it has to
   * say what it is waiting for and what would make the wait shorter.
   */
  it("says what it is still reading once the wait is long enough to notice", async () => {
    vi.useFakeTimers();
    let resolve: (answer: Scoped<Item>) => void = () => {};
    const pending = new Promise<Scoped<Item>>((done) => {
      resolve = done;
    });
    await draw(
      <ResourceList<Item>
        title="Pods"
        columns={columns}
        emptyStateLabel="Pods"
        queryKey={["pods", "slow"]}
        queryFn={() => pending}
      />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByTestId("slow-read")).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLOW_READ_MS + 1000);
    });
    expect(screen.getByTestId("slow-read")).toHaveTextContent(
      /Still reading pods/
    );

    resolve({ rows: [{ name: "web", namespace: "default" }], unread: [] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByTestId("slow-read")).not.toBeInTheDocument();
  });

  /**
   * Three things the deadline screen used to get wrong at once: a count of
   * zero in the header, directly above the sentence saying the read did not
   * finish; the `READ_DEADLINE:` wire marker printed at the reader in
   * English under a sentence that already said it in their language; and a
   * Retry wired to the disabled placeholder query, which writes `[]` under
   * a key the page never reads.
   */
  it("says nothing it could not know when the read ran out of time", async () => {
    const retried = vi.fn();
    await draw(
      <ResourceList<Item>
        title="Pods"
        columns={columns}
        emptyStateLabel="Pods"
        data={[]}
        error={
          new Error("READ_DEADLINE: the cluster did not answer within 60 s")
        }
        onRetry={retried}
      />
    );

    expect(screen.getByText(/did not finish within/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("READ_DEADLINE:");
    expect(screen.queryByText("0")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(retried).toHaveBeenCalledTimes(1);
  });

  /**
   * The pages this was built for do not own the read. Pods, every workload
   * list and CRDs hand their rows in as `data`, which disables the internal
   * query — so a wait read off that query is a wait nobody is having, and
   * the block never appears on precisely the lists big enough to need it.
   * The caller says when it started waiting, the way it already says
   * `slowed`.
   */
  it("says what it is still reading when the rows come from the caller", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    await draw(
      <ResourceList<Item>
        title="Pods"
        columns={columns}
        emptyStateLabel="Pods"
        data={undefined}
        isLoading
        waitingSince={startedAt}
      />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByTestId("slow-read")).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLOW_READ_MS + 1000);
    });
    expect(screen.getByTestId("slow-read")).toHaveTextContent(
      /Still reading pods/
    );
  });
});

describe("what a list hands to Share", () => {
  /** The list as Share collects it, with the read in whatever state the props say. */
  async function collected(props: {
    data?: Item[];
    error?: Error | null;
    unread?: UnreadNamespace[];
  }): Promise<PlacedSection[]> {
    let collect: (() => PlacedSection[]) | null = null;
    function Probe() {
      collect = useScreenSections();
      return null;
    }
    await draw(
      <ScreenShareProvider>
        <ResourceList<Item>
          title="Pods"
          columns={columns}
          emptyStateLabel="Pods"
          {...props}
        />
        <Probe />
      </ScreenShareProvider>
    );
    return collect!();
  }

  /**
   * Refused outright, the list has no table and registered nothing; the
   * file had no sections and still said everything was read.
   */
  it("says the list could not be read when the read failed", async () => {
    const [section] = await collected({
      data: [],
      error: new Error("pods is forbidden: RBAC"),
    });
    expect(section.unread).toMatch(/forbidden/);
  });

  /**
   * Two of three namespaces answered: the page names the third and drops
   * the total, and the file wrote the rows it had as the whole list.
   */
  it("draws the rows it has and names the namespace that did not answer", async () => {
    const [section] = await collected({
      data: [{ name: "web-1", namespace: "shop" }],
      unread: [{ namespace: "team-c", code: "Forbidden", message: "denied" }],
    });
    expect(section.partial).toMatch(/team-c/);
    expect(section.count).toBeNull();
  });

  it("gives the whole count when every namespace answered", async () => {
    const [section] = await collected({
      data: [{ name: "web-1", namespace: "shop" }],
    });
    expect(section.partial ?? null).toBeNull();
    expect(section.count).toBe(1);
  });
});

describe("what a list is of", () => {
  /**
   * Lena had nowhere to learn what a Pod was. Every typed list now says, and
   * links the page Kubernetes keeps about it; fails if the sentence or the
   * link goes, or the link stops leaving the app through the host.
   */
  it("says what the kind is and links its Kubernetes page", async () => {
    const user = userEvent.setup();
    await list({ data: [] });
    expect(
      screen.getByText(/A Pod is one running copy of an app/)
    ).toBeVisible();
    const more = screen.getByRole("link", { name: /Learn more/ });
    expect(more).toHaveAttribute(
      "href",
      "https://kubernetes.io/docs/concepts/workloads/pods/"
    );
    await user.click(more);
    expect(openExternal).toHaveBeenCalledWith(
      "https://kubernetes.io/docs/concepts/workloads/pods/",
      "kubernetes.io",
      expect.any(Function)
    );
  });

  /** A list of something the registry cannot name keeps the caller's own line. */
  it("keeps a caller's description over the kind's", async () => {
    await draw(
      <ResourceList<Item>
        title="Applications"
        description="applications.argoproj.io"
        columns={columns}
        emptyStateLabel="Applications"
        data={[]}
      />
    );
    expect(screen.getByText("applications.argoproj.io")).toBeVisible();
    expect(screen.queryByRole("link", { name: /Learn more/ })).toBeNull();
  });
});
