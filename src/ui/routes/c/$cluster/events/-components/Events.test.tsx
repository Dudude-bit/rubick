/**
 * The feed's one promise: the number the reader picked is a number of events
 * *in the scope they picked*.
 */

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

vi.mock("@/lib/commands", () => ({
  commands: {
    listEvents: vi.fn(async () => []),
    getPod: vi.fn(async () => ({ containers: [] })),
    checkListAccess: vi.fn(async () => []),
  },
}));

import {
  ScreenShareProvider,
  useScreenSections,
} from "@/components/share/screen-share";
import { commands } from "@/lib/commands";
import { SCOPE_PICKER_OPEN } from "@/lib/read-deadline";
import { startWindowActivity } from "@/lib/window-activity";
import { queryKeys } from "@/lib/query-keys";
import { useClusterStore } from "@/stores/clusterStore";
import { useLocaleStore } from "@/stores/localeStore";
import type { EventFilters, EventInfo } from "@/generated/types";
import { renderWithRouter } from "@/test/render";
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

/**
 * A filter no event can match.
 *
 * Two characters rather than twenty: `userEvent.type` fires a keystroke each,
 * and each keystroke refilters the whole feed — which in the tests below is
 * the five-hundred-event one. The characters are not what is under test; that
 * nothing matches them is.
 */
const NO_MATCH = "zq";

const feed = (namespace: string, count: number) =>
  Array.from({ length: count }, (_, index) => event(namespace, index));

function eventsAt(view: "list" | "stories") {
  return {
    at: `/c/prod/events?view=${view}`,
    route: "/c/$cluster/events",
  };
}

async function mount(view: "list" | "stories" = "list") {
  let bump = () => {};
  // A fresh element every time: React bails out of re-rendering a component
  // whose element it has already seen, so a redraw that reuses one proves
  // nothing about what a render costs.
  function Host() {
    const [, setTick] = useState(0);
    bump = () => setTick((tick) => tick + 1);
    return <Events />;
  }
  const rendered = await renderWithRouter(<Host />, eventsAt(view));
  return {
    ...rendered,
    redraw: () => {
      act(() => bump());
    },
  };
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
    await mount();

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
    await mount();

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
    await mount();

    // 300 + 300 kept as 500: the header counts what is on screen and names
    // the limit that is hiding the rest.
    expect(
      await screen.findByText(/500 normal · latest 500/)
    ).toBeInTheDocument();
    // Five hundred rows in jsdom is the most expensive render in the suite.
    // Alone it takes about a second; sharing eight cores with the rest of
    // the files it has been seen at twelve, which the 5s default turns into
    // a failure that says "timed out" about code that is working. The number
    // is headroom for a loaded machine, not an expectation.
  }, 30_000);
});

describe("narrowing the feed", () => {
  /**
   * The filter runs against the whole pool the limit bought, not against
   * what is left after the cut. Searching the cut would read the newest 500
   * rows and report "none" about a cluster that has the row, just further
   * back than the window.
   */
  it("searches the pool, not the page", async () => {
    useClusterStore.setState({
      namespaceScope: ["prod"],
      currentNamespace: "prod",
    });
    listEvents.mockImplementation(async () => {
      const rows = feed("prod", 40);
      // The one row worth finding is the oldest, past any small cut.
      rows[rows.length - 1] = {
        ...rows[rows.length - 1],
        involvedObject: {
          kind: "Pod",
          name: "needle-pod",
          namespace: "prod",
          uid: null,
        },
      };
      return rows;
    });
    await mount();

    await waitFor(() =>
      expect(document.body.textContent).toContain("prod-pod-0")
    );

    const box = screen.getByPlaceholderText(/filter events/i);
    await userEvent.type(box, "needle");

    await waitFor(() =>
      expect(document.body.textContent).toContain("needle-pod")
    );
    expect(document.body.textContent).not.toContain("prod-pod-0");
  });

  /**
   * A feed filtered down to nothing has not told the reader their scope is
   * quiet. It has told them their query missed, and those have different
   * next moves.
   */
  it("says the query missed rather than that the scope is empty", async () => {
    useClusterStore.setState({
      namespaceScope: ["prod"],
      currentNamespace: "prod",
    });
    listEvents.mockImplementation(async () => feed("prod", 5));
    await mount();

    await waitFor(() =>
      expect(document.body.textContent).toContain("prod-pod-0")
    );

    await userEvent.type(
      screen.getByPlaceholderText(/filter events/i),
      NO_MATCH
    );

    await waitFor(() =>
      expect(screen.getByText(/matches/i)).toBeInTheDocument()
    );
    expect(document.body.textContent).not.toMatch(/No events in .* yet/);
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
    const { redraw } = await mount();
    await waitFor(() =>
      expect(document.body.textContent).toContain("staging-pod-0")
    );

    const sort = vi.spyOn(Array.prototype, "sort");
    redraw();
    expect(sort).not.toHaveBeenCalled();
    sort.mockRestore();
  });

  /**
   * The filter and the limit are two different ceilings, and a search that
   * finds nothing must not be worded as an empty scope. Nothing here says
   * the pod has no events — only that none of the ones actually read match,
   * and the reading stopped at the limit somebody chose.
   */
  it("says the search stopped at the limit rather than that the scope is quiet", async () => {
    useClusterStore.setState({
      namespaceScope: ["prod"],
      currentNamespace: "prod",
    });
    // A full window: the apiserver gave back everything the limit allows.
    listEvents.mockImplementation(async () => feed("prod", 500));
    await mount();

    await screen.findByText(/500 normal/);
    await userEvent.type(
      screen.getByPlaceholderText(/Filter events/i),
      NO_MATCH
    );

    const said = await screen.findByText(/latest 500 events/i);
    expect(said).toBeInTheDocument();
    // The honest half: it says what was searched, not what exists.
    expect(said.textContent).toMatch(/not read/i);
    // The five-hundred-row render above, and a filter typed over it. This
    // one used to spend twenty keystrokes on a string nothing asserts, and
    // each keystroke refilters the whole feed: 33s, over the budget the
    // test above set for a render alone. Two characters bring it to 23s,
    // and the rest is headroom for the same loaded machine.
  }, 45_000);
});

describe("stories", () => {
  const warning = (
    namespace: string,
    name: string,
    index: number
  ): EventInfo => ({
    ...event(namespace, index),
    uid: `${namespace}-warn-${index}`,
    type: "Warning",
    reason: "BackOff",
    message: "Back-off restarting failed container app",
    count: 7,
    involvedObject: { kind: "Pod", name, namespace, uid: null },
    lastTimestamp: new Date(Date.now() - 30_000).toISOString(),
  });

  /** The default view is the story, not the row: one sentence per object, worded from the counts. */
  it("opens on stories and words a crash loop from its events", async () => {
    listEvents.mockResolvedValue([warning("prod", "api-7b6d9c5f4-x8k2p", 0)]);
    await mount("stories");

    const card = await screen.findByRole("article", { name: /api/ });
    expect(card.textContent).toContain("Cannot stay up");
    expect(card.textContent).toContain("7 times");
    expect(card.textContent).toContain("still happening");
    // Folded by name and honest about it.
    expect(card.textContent).toContain("Grouped by the generated suffix");
    expect(screen.getByRole("tab", { name: "Stories" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  /**
   * The timeline reads each pod's remembered exits under the key it said
   * every other reader used — plural-first, while the pod page's is singular
   * — so a pod was fetched twice and a restart on its page never reached the
   * story. Fails if the timeline keys the pod apart from its page again.
   */
  it("reads each pod on the timeline from the entry its own page keeps", async () => {
    const pod = "api-7b6d9c5f4-x8k2p";
    listEvents.mockResolvedValue([warning("prod", pod, 0)]);
    const { client } = await mount("stories");

    const card = await screen.findByRole("article", { name: /api/ });
    await userEvent.click(
      within(card).getByRole("button", { name: "Timeline" })
    );

    await waitFor(() =>
      expect(client.getQueryData(queryKeys.detail("Pod", "prod", pod))).toEqual(
        { containers: [] }
      )
    );
  });

  /** A quiet window is a real answer only because the read succeeded; the copy says both. */
  it("says the window is quiet rather than drawing nothing", async () => {
    await mount("stories");
    expect(
      await screen.findByText(/Nothing happened in .* in the last 1 hour/)
    ).toBeInTheDocument();
  });

  /**
   * The quiet sentence is byte-identical to what a swallowed refusal used to
   * draw — and the sentence went as far as "the read succeeded", about a
   * request that came back 403. An assertion on the empty feed proves nothing
   * unless the refused feed says something else.
   */
  it("says a refused read was refused, not that the scope is quiet", async () => {
    listEvents.mockRejectedValue(
      new Error(
        'events is forbidden: User "alice" cannot list resource "events"'
      )
    );
    await mount("stories");
    expect(
      await screen.findByText(/across the whole cluster was refused/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/Nothing happened in/)).not.toBeInTheDocument();
    expect(document.body.textContent).toContain("forbidden");
    // "0 stories · none" beside the refusal said the opposite of it.
    const heading = screen.getByRole("heading", { name: "Events" });
    expect(
      within(heading.parentElement!).queryByTestId("section-count")
    ).toBeNull();
  });

  /**
   * Marco under All namespaces: events are refused across the cluster and
   * readable in team-checkout, yet the page said it could not read them in
   * any namespace and offered no way there. Fails if the feed stops naming
   * where they can be listed or drops the picker the lists offer.
   */
  it("names the namespace a refused feed reads in, and offers the picker", async () => {
    useClusterStore.setState({
      currentContext: "prod",
      contexts: [{ name: "prod", namespace: "team-checkout" } as never],
    });
    vi.mocked(commands.checkListAccess).mockImplementation(
      async (queries, namespaces) =>
        queries.map((query) => ({
          resource: query.resource,
          allowed: namespaces[0] === "team-checkout",
        }))
    );
    listEvents.mockRejectedValue(
      new Error(
        'events is forbidden: User "marco" cannot list resource "events" at the cluster scope'
      )
    );
    await mount("stories");

    expect(
      await screen.findByText("You can list them in team-checkout.")
    ).toBeVisible();
    expect(
      screen.getByText(/across the whole cluster was refused/)
    ).toBeVisible();
    expect(screen.queryByText(/may still answer/)).toBeNull();
    expect(screen.queryByText(/Could not read the events/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Choose a namespace" })
    ).toBeVisible();
    expect(commands.checkListAccess).toHaveBeenCalledWith(
      [{ group: "", resource: "events", namespaced: true }],
      ["team-checkout"]
    );
    useClusterStore.setState({ currentContext: null, contexts: [] });
  });

  /**
   * A Russian card read "Пробы упали", "Не скачать образ" and the window
   * buttons "15m" and "1h" beside sentences that said «15 минут».
   */
  it("words a story and its window in Russian", async () => {
    useLocaleStore.setState({ choice: "ru" });
    try {
      listEvents.mockResolvedValue([warning("prod", "api-7b6d9c5f4-x8k2p", 0)]);
      await mount("stories");
      const card = await screen.findByRole("article", { name: /api/ });
      expect(card.textContent).toMatch(/Контейнер раз за разом падает/);
      expect(card.textContent).toContain("продолжается");
      const windows = screen.getByRole("group", { name: "Окно" });
      expect(windows).toHaveTextContent(/15\sмин/);
      expect(windows.textContent).not.toMatch(/\d+[mh]\b/);
    } finally {
      useLocaleStore.setState({ choice: null });
    }
  });

  it("keeps the flat list one tab away", async () => {
    listEvents.mockResolvedValue([warning("prod", "api-7b6d9c5f4-x8k2p", 0)]);
    await mount("stories");
    await screen.findByRole("article", { name: /api/ });
    await userEvent.click(screen.getByRole("tab", { name: "All events" }));
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(document.body.textContent).toContain("BackOff");
  });
});

describe("the way out of a refused feed", () => {
  /**
   * Marco's first click on Choose a namespace after arriving on Events did
   * nothing, 7 of 7: the click woke the quiet poll, the refused read went
   * back to loading, and the button was gone before the click landed.
   */
  it("opens the namespace picker on the first click after a quiet stay", async () => {
    const stop = startWindowActivity();
    const opened = vi.fn();
    window.addEventListener(SCOPE_PICKER_OPEN, opened);
    useClusterStore.setState({
      currentContext: "prod",
      contexts: [{ name: "prod", namespace: "team-checkout" } as never],
    });
    vi.mocked(commands.checkListAccess).mockImplementation(
      async (queries, namespaces) =>
        queries.map((query) => ({
          resource: query.resource,
          allowed: namespaces[0] === "team-checkout",
        }))
    );
    listEvents.mockRejectedValue(
      Object.assign(new Error("events is forbidden"), {
        code: "PERMISSION_DENIED",
      })
    );
    const user = userEvent.setup();
    try {
      await mount("stories");
      await screen.findByRole("button", { name: "Choose a namespace" });
      await waitFor(() => expect(listEvents).toHaveBeenCalledTimes(3), {
        timeout: 4000,
      });
      const later = Date.now() + 5000;
      vi.spyOn(Date, "now").mockReturnValue(later);
      await user.click(
        screen.getByRole("button", { name: "Choose a namespace" })
      );
      expect(opened).toHaveBeenCalledTimes(1);
    } finally {
      vi.mocked(Date.now).mockRestore();
      window.removeEventListener(SCOPE_PICKER_OPEN, opened);
      stop();
      useClusterStore.setState({ currentContext: null, contexts: [] });
    }
  });
});

describe("what the page offers Share", () => {
  /** Deleting the registration leaves a colleague's report of "what's on
   *  screen" with no events in it at all, in either view. */
  it("collects an events section carrying what is on screen, in both views", async () => {
    listEvents.mockResolvedValue([{ ...event("prod", 0), type: "Warning" }]);
    let collect: ReturnType<typeof useScreenSections> = null;
    function Probe() {
      collect = useScreenSections();
      return null;
    }
    await renderWithRouter(
      <ScreenShareProvider>
        <Events />
        <Probe />
      </ScreenShareProvider>,
      eventsAt("list")
    );

    await waitFor(() => {
      const events = collect?.().find((section) => section.id === "events");
      expect(events?.count).toBe(1);
    });
    const sections = collect!();
    expect(sections.some((section) => section.id === "events-filters")).toBe(
      true
    );
  });
});
