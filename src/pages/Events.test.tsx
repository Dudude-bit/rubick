/**
 * The feed's one promise: the number the reader picked is a number of events
 * *in the scope they picked*.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/commands", () => ({
  commands: { listEvents: vi.fn(async () => []) },
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import type { EventFilters, EventInfo } from "@/generated/types";
import { Events } from "./Events";

const listEvents = vi.mocked(commands.listEvents);

const event = (namespace: string, index: number): EventInfo => ({
  name: `${namespace}-${index}`,
  namespace,
  uid: `${namespace}-${index}`,
  type: "Normal",
  reason: "Started",
  message: "Started container",
  source: null,
  involvedObject: {
    kind: "Pod",
    name: `${namespace}-pod-${index}`,
    namespace,
    uid: null,
  },
  count: 1,
  // Descending inside a namespace, as the backend hands them over, and
  // interleaved across namespaces so the join has to actually sort.
  firstTimestamp: null,
  lastTimestamp: `2026-08-05T10:${String(59 - index).padStart(2, "0")}:00Z`,
});

const feed = (namespace: string, count: number) =>
  Array.from({ length: count }, (_, index) => event(namespace, index));

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // A fresh element every time: React bails out of re-rendering a component
  // whose element it has already seen, so a redraw that reuses one proves
  // nothing about what a render costs.
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>
          <Events />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, redraw: () => view.rerender(tree()) };
}

const asked = () =>
  listEvents.mock.calls.map(([filters]) => filters as EventFilters);

beforeEach(() => {
  listEvents.mockReset();
  listEvents.mockResolvedValue([]);
  useClusterStore.setState({
    isConnected: true,
    currentNamespace: "",
    namespaceScope: [],
  });
});

describe("what the limit is counted against", () => {
  /**
   * Would put the bug back: one cluster-wide read for 500 events, narrowed
   * afterwards, hands the whole budget to whichever namespace is loudest —
   * and the page then says "No events in 2 namespaces yet" while the one the
   * reader is watching is emitting.
   */
  it("asks each selected namespace for the limit the reader chose", async () => {
    useClusterStore.setState({ namespaceScope: ["prod", "staging"] });
    listEvents.mockImplementation(async (filters) =>
      feed(filters?.namespace ?? "", 2)
    );
    mount();

    await waitFor(() => expect(listEvents).toHaveBeenCalledTimes(2));
    expect(
      asked()
        .map((f) => f.namespace)
        .sort()
    ).toEqual(["prod", "staging"]);
    // The whole limit each, not a share of it: a share starves the busy
    // namespace and goes unspent in the quiet one.
    expect(asked().every((f) => f.limit === 500)).toBe(true);

    // Both namespaces are on screen, which is the whole point of the scope.
    // Read off the whole feed rather than a node: a row's object name is
    // drawn by `ResourceRef` in pieces.
    await waitFor(() =>
      expect(document.body.textContent).toContain("prod-pod-0")
    );
    expect(document.body.textContent).toContain("staging-pod-0");
  });

  /** One namespace or none is one request, exactly as it always was. */
  it("still asks once for a scope the API server can answer directly", async () => {
    useClusterStore.setState({
      namespaceScope: ["prod"],
      currentNamespace: "prod",
    });
    mount();

    await waitFor(() => expect(listEvents).toHaveBeenCalledTimes(1));
    expect(asked()[0].namespace).toBe("prod");
  });

  /**
   * The join can hold more than the reader asked for, and "latest 500" has
   * to keep meaning 500 — with the newest kept and the overflow declared
   * rather than a feed that silently ends.
   */
  it("cuts the join back to the limit and says it did", async () => {
    useClusterStore.setState({ namespaceScope: ["prod", "staging"] });
    listEvents.mockImplementation(async (filters) =>
      feed(filters?.namespace ?? "", 300)
    );
    mount();

    // 300 + 300 kept as 500: the header counts what is on screen and names
    // the limit that is hiding the rest.
    expect(
      await screen.findByText(/500 normal · latest 500/)
    ).toBeInTheDocument();
  });
});

describe("what the join costs", () => {
  /**
   * `useQueries` hands back a new result array — and a new wrapper per part —
   * on every render, so a join keyed on it is rebuilt on every render. At "No
   * limit" across four busy namespaces that is a several-thousand-element
   * flatMap and sort per render, including the renders the poll's own backoff
   * causes. Keyed on the answers instead, it costs one per answer.
   */
  it("re-sorts only when a namespace has answered again", async () => {
    useClusterStore.setState({ namespaceScope: ["prod", "staging"] });
    listEvents.mockImplementation(async (filters) =>
      feed(filters?.namespace ?? "", 50)
    );
    const { redraw } = mount();
    await waitFor(() =>
      expect(document.body.textContent).toContain("staging-pod-0")
    );

    const sort = vi.spyOn(Array.prototype, "sort");
    redraw();
    expect(sort).not.toHaveBeenCalled();
    sort.mockRestore();
  });
});
