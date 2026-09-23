/**
 * What the list says when the read did not work.
 *
 * "The scope holds none of these" and "the app could not find out" are
 * different sentences with different fixes, and the table's empty state is
 * only ever entitled to the first one.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ColumnDef } from "@/components/ui/table-features";

import { TooltipProvider } from "@/components/ui/tooltip";

const store = vi.hoisted(() => ({
  state: {
    currentNamespace: "default",
    namespaceScope: [] as string[],
    isConnected: true,
  },
}));

vi.mock("@/stores/clusterStore", () => ({
  useClusterStore: vi.fn(<T,>(selector?: (s: typeof store.state) => T) =>
    typeof selector === "function" ? selector(store.state) : store.state
  ),
}));

import { ResourceList } from "./ResourceList";
import type { Scoped, UnreadNamespace } from "@/generated/types";
import { SCOPE_PICKER_OPEN, SLOW_READ_MS } from "@/lib/read-deadline";

interface Item {
  name: string;
  namespace: string;
}

const columns: ColumnDef<Item>[] = [{ accessorKey: "name", header: "Name" }];

const list = (props: {
  data?: Item[];
  error?: Error | null;
  unread?: UnreadNamespace[];
  queryKey?: string[];
  queryFn?: () => Promise<Scoped<Item>>;
}) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={["/pods"]}>
        <TooltipProvider>
          <ResourceList<Item>
            title="Pods"
            columns={columns}
            emptyStateLabel="Pods"
            {...props}
          />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );

describe("a list whose rows come from outside", () => {
  /**
   * The regression this exists for. A page that fetches its own rows — one
   * with `usePodsWithMetrics` behind it, or a workload list — hands
   * `ResourceList` an array either way, so a scope the token cannot read and a
   * scope with nothing in it arrived here identical. Every such page told the
   * reader their cluster had no pods.
   */
  it("says the read failed rather than that the scope is empty", () => {
    list({ data: [], error: new Error("connection reset by peer") });

    expect(screen.getByText(/Could not read Pods in this scope/)).toBeVisible();
    expect(screen.getByText(/connection reset/)).toBeVisible();
  });

  /**
   * A refusal is not a failure. "Could not read" describes something broken
   * and invites a retry that will be refused in exactly the same way, which
   * is how an ordinary RBAC boundary came to read as a fault in the app.
   */
  it("says a refusal is a refusal", () => {
    list({ data: [], error: new Error("pods is forbidden: RBAC") });

    expect(
      screen.getByText(/do not have permission to list these/)
    ).toBeVisible();
    expect(screen.queryByText(/Could not read/)).not.toBeInTheDocument();
    // The cluster's own words stay: they name the resource and the user,
    // which is what somebody takes to whoever grants the rights.
    expect(screen.getByText(/forbidden/)).toBeVisible();
  });

  /** No error, no rows: the scope really is empty, and says so. */
  it("draws the empty state when nothing failed", () => {
    list({ data: [] });

    expect(screen.queryByText(/Could not read/)).not.toBeInTheDocument();
    expect(screen.getByText(/No resources of this type/)).toBeVisible();
  });

  /**
   * The same rule the internal query already followed: a failed re-read over
   * rows that are still on screen is not worth throwing the page away for.
   */
  it("keeps the rows it has when a re-read fails", () => {
    list({
      data: [{ name: "api-7bcd", namespace: "default" }],
      error: new Error("connection reset"),
    });

    expect(screen.getByText("api-7bcd")).toBeVisible();
    expect(screen.queryByText(/Could not read/)).not.toBeInTheDocument();
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
  it("names the namespace it could not read beside the rows of the rest", () => {
    store.state.namespaceScope = ["prod", "staging"];
    list({ data: [{ name: "api", namespace: "prod" }], unread: [refused] });

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
    list({
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
  it("does not call the rows a total in the footer either", () => {
    store.state.namespaceScope = ["prod", "staging"];
    list({ data: [{ name: "api", namespace: "prod" }], unread: [refused] });

    expect(
      screen.getByText("1 pod, from the namespaces that answered")
    ).toBeInTheDocument();
    expect(screen.queryByText("1 pod")).toBeNull();
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
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/pods"]}>
          <TooltipProvider>
            <ResourceList<Item>
              title="Pods"
              columns={columns}
              emptyStateLabel="Pods"
              queryKey={queryKey}
              queryFn={answer}
            />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
    const { rerender } = render(
      page(["pods", "prod,staging"], async () => ({
        rows: [{ name: "api", namespace: "prod" }],
        unread: [refused],
      }))
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
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/pods"]}>
          <TooltipProvider>
            <ResourceList<Item>
              title="Pods"
              columns={columns}
              emptyStateLabel="Pods"
              queryKey={key}
              queryFn={answer}
              live
            />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>
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
    list({
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
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter initialEntries={["/pods"]}>
          <TooltipProvider>
            <ResourceList<Item>
              title="Pods"
              columns={columns}
              emptyStateLabel="Pods"
              queryKey={["pods", "slow"]}
              queryFn={() => pending}
            />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>
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
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter initialEntries={["/pods"]}>
          <TooltipProvider>
            <ResourceList<Item>
              title="Pods"
              columns={columns}
              emptyStateLabel="Pods"
              data={[]}
              error={
                new Error(
                  "READ_DEADLINE: the cluster did not answer within 60 s"
                )
              }
              onRetry={retried}
            />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>
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
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter initialEntries={["/pods"]}>
          <TooltipProvider>
            <ResourceList<Item>
              title="Pods"
              columns={columns}
              emptyStateLabel="Pods"
              data={undefined}
              isLoading
              waitingSince={startedAt}
            />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>
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
