/**
 * The feed's one promise: the number the reader picked is a number of events
 * *in the scope they picked*.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler, useState } from "react";

const listeners = vi.hoisted(
  () => ({}) as Record<string, Array<(event: { payload: unknown }) => void>>
);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (event: string, handler: (event: { payload: unknown }) => void) => {
      (listeners[event] ??= []).push(handler);
      return () => {
        listeners[event] = (listeners[event] ?? []).filter(
          (h) => h !== handler
        );
      };
    }
  ),
  emit: vi.fn(async () => {}),
  once: vi.fn(async () => () => {}),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    listEvents: vi.fn(async () => []),
    getPod: vi.fn(async () => ({ containers: [] })),
    checkListAccess: vi.fn(async () => []),
    subscribeEventWatch: vi.fn(async () => "events-1"),
    resourceWatchSubscribed: vi.fn(async () => undefined),
    unsubscribeResourceWatch: vi.fn(async () => undefined),
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
const subscribeEventWatch = vi.mocked(commands.subscribeEventWatch);

/** A cluster that lets this user list events and not watch them. */
const WATCH_REFUSED = Object.assign(
  new Error('events is forbidden: User "alice" cannot watch resource "events"'),
  { code: "PERMISSION_DENIED" }
);

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
  // The feed as it was read before the watch, and still is where none runs.
  subscribeEventWatch.mockReset();
  subscribeEventWatch.mockRejectedValue(WATCH_REFUSED);
  vi.mocked(commands.resourceWatchSubscribed).mockClear();
  useClusterStore.setState((s) => ({
    isConnected: true,
    currentNamespace: "",
    namespaceScope: [],
    connectionAttemptId: s.connectionAttemptId + 1,
  }));
});

type Change = { op: string; resource: EventInfo | null };

function send(changes: Change[], error: string | null = null) {
  act(() => {
    for (const heard of listeners["resource-event"] ?? [])
      heard({ payload: { stream_id: "events-1", changes, error } });
  });
}

/** A watch's first read as the backend sends it: two hundred to a batch. */
function burst(rows: EventInfo[]) {
  const changes: Change[] = [
    { op: "restarted", resource: null },
    ...rows.map((resource) => ({ op: "applied", resource })),
    { op: "synced", resource: null },
  ];
  for (let at = 0; at < changes.length; at += 200)
    send(changes.slice(at, at + 200));
}

const BASE = Date.UTC(2026, 7, 5, 10, 0, 0);
/** `index` seconds before the newest, named so the API's order is not time order. */
const dated = (namespace: string, index: number): EventInfo => ({
  ...event(namespace, index),
  lastTimestamp: new Date(BASE - index * 1000).toISOString(),
});

const rowAt = (index: number) =>
  document.querySelector<HTMLElement>(`tr[data-row-index="${index}"]`);
const drawnRows = () => document.querySelectorAll("tr[data-row-index]").length;

const restoreLayout: Array<() => void> = [];
/** jsdom lays nothing out; a 600px port of 26px rows is enough for the virtualiser to draw a window. */
function layOutRows() {
  const stub = (proto: object, name: string, get: () => unknown) => {
    const original = Object.getOwnPropertyDescriptor(proto, name);
    Object.defineProperty(proto, name, { configurable: true, get });
    restoreLayout.push(() => {
      if (original) Object.defineProperty(proto, name, original);
      else delete (proto as Record<string, unknown>)[name];
    });
  };
  stub(HTMLElement.prototype, "offsetHeight", function (this: HTMLElement) {
    return this.tagName === "TR" ? 26 : 600;
  });
  stub(Element.prototype, "clientHeight", () => 600);
}
afterEach(() => {
  restoreLayout.splice(0).forEach((restore) => restore());
});

describe("a feed a watch keeps", () => {
  const WATCH_KEY = [...queryKeys.events(null), "watch"];
  const rowsOf = (client: { getQueryData: (key: unknown[]) => unknown }) =>
    (client.getQueryData(WATCH_KEY) as { rows: EventInfo[] } | undefined)
      ?.rows ?? [];

  beforeEach(() => {
    subscribeEventWatch.mockReset();
    subscribeEventWatch.mockResolvedValue("events-1");
  });

  async function watched(view: "list" | "stories" = "list") {
    const mounted = await mount(view);
    await waitFor(() =>
      expect(commands.resourceWatchSubscribed).toHaveBeenCalledWith("events-1")
    );
    return mounted;
  }

  /**
   * Dana's All events re-read the latest 500 every second, 350 KB each
   * time. Fails if the feed is polled while its watch runs, if the first
   * read is anything but the watch's batches, if the newest are not on top
   * of a burst that arrived in the API's order, or if the cut stops saying
   * which 500 these are.
   */
  it("reads the feed from the watch's batches and asks nothing again while it runs", async () => {
    layOutRows();
    await watched();
    expect(subscribeEventWatch).toHaveBeenCalledWith(null);
    const rows = Array.from({ length: 600 }, (_, index) =>
      dated("prod", index)
    ).sort((a, b) => (a.name < b.name ? -1 : 1));
    burst(rows);

    expect(
      await screen.findByText("500 normal events · of the latest 500")
    ).toBeInTheDocument();
    expect(rowAt(0)?.textContent).toContain("prod-pod-0");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(listEvents).not.toHaveBeenCalled();
    expect(screen.getByText("live")).toBeInTheDocument();
  }, 30_000);

  /**
   * Dana's idle All events list stalled the window on every batch: all 500
   * rows were in the DOM, and a new one on top moved every one of them.
   * Fails if the feed draws more than a screenful of its rows.
   */
  it("draws only the rows on screen of a feed of five hundred", async () => {
    layOutRows();
    await watched();
    burst(Array.from({ length: 500 }, (_, index) => dated("prod", index)));
    await waitFor(() => expect(rowAt(0)?.textContent).toContain("prod-pod-0"));
    expect(drawnRows()).toBeGreaterThan(0);
    expect(drawnRows()).toBeLessThan(60);
  }, 30_000);

  /**
   * Rows shifted about 25 places between two looks, so a click landed on
   * another event. Fails if a batch moves the rows while the pointer is on
   * the list, or if what arrived meanwhile cannot be reached.
   */
  it("holds its rows while the pointer is on the list and offers what arrived", async () => {
    await watched();
    burst(Array.from({ length: 5 }, (_, index) => dated("prod", index + 1)));
    await waitFor(() => expect(rowAt(0)?.textContent).toContain("prod-pod-1"));

    await userEvent.hover(rowAt(2)!);
    send([{ op: "applied", resource: dated("prod", 0) }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rowAt(0)?.textContent).toContain("prod-pod-1");
    expect(rowAt(2)?.textContent).toContain("prod-pod-3");

    await userEvent.click(
      await screen.findByRole("button", { name: "Show 1 update" })
    );
    expect(rowAt(0)?.textContent).toContain("prod-pod-0");
    expect(
      screen.queryByRole("button", { name: /Show \d+ update/ })
    ).not.toBeInTheDocument();

    send([{ op: "applied", resource: dated("prod", 6) }]);
    await userEvent.unhover(rowAt(2)!);
    await waitFor(() => expect(drawnRows()).toBe(7));
  });

  /**
   * Dana found no gesture on an Events row that reached the object's Events
   * tab, and rows that answered neither a click nor a right click. Fails if
   * the row's click, its object link, its double click or its menu forgets
   * the Event.
   */
  it("opens an Event's object on its Events tab from every gesture on the row", async () => {
    const { router } = await watched();
    const about = (kind: string, name: string, index: number): EventInfo => ({
      ...dated("shop", index),
      name: `${name}.17f3`,
      involvedObject: { kind, name, namespace: "shop", uid: null },
    });
    burst([about("Deployment", "cart", 0), about("Service", "web", 1)]);
    await waitFor(() => expect(drawnRows()).toBe(2));
    const search = () => router.state.location.search as Record<string, string>;

    await userEvent.click(within(rowAt(0)!).getByText("Started container"));
    expect(search().peek).toBe("deployments/shop/cart");
    expect(search().peekVia).toBe("events/shop/cart.17f3");

    expect(
      within(rowAt(0)!).getByRole("link", { name: "Deployment cart" })
    ).toHaveAttribute(
      "href",
      "/c/prod/deployments/shop/cart?tab=events&via=events%2Fshop%2Fcart.17f3"
    );
    expect(
      within(rowAt(1)!).getByRole("link", { name: "Service web" })
    ).toHaveAttribute(
      "href",
      "/c/prod/services/shop/web?tab=events&via=events%2Fshop%2Fweb.17f3"
    );

    await userEvent.pointer({ keys: "[MouseRight]", target: rowAt(1)! });
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");

    await userEvent.dblClick(within(rowAt(0)!).getByText("Started container"));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/c/prod/deployments/shop/cart"
      )
    );
    expect(search().tab).toBe("events");
    expect(search().via).toBe("events/shop/cart.17f3");
  });

  /** Dana's story title opened a peek that knew nothing of the Event. Fails if the card's link drops it. */
  it("links a story's object to its Events tab, noting the latest Event about it", async () => {
    await watched("stories");
    const now = Date.now();
    burst([
      {
        ...event("shop", 0),
        name: "cart.17f3",
        type: "Warning",
        reason: "ProgressDeadlineExceeded",
        involvedObject: {
          kind: "Deployment",
          name: "cart",
          namespace: "shop",
          uid: null,
        },
        lastTimestamp: new Date(now - 60_000).toISOString(),
      },
    ]);
    const card = await screen.findByRole("article", {
      name: "Deployment cart",
    });
    expect(
      within(card).getByRole("link", { name: "Deployment cart" })
    ).toHaveAttribute(
      "href",
      "/c/prod/deployments/shop/cart?tab=events&via=events%2Fshop%2Fcart.17f3"
    );
  });

  /** Dana could not sort the feed by Age as every list sorts. Fails if the header stops sorting. */
  it("sorts the list by Age, oldest first on the second click", async () => {
    await watched();
    burst([dated("prod", 0), dated("prod", 2), dated("prod", 1)]);
    await waitFor(() => expect(rowAt(0)?.textContent).toContain("prod-pod-0"));

    const age = screen.getByRole("button", {
      name: "Age: Sort by this column",
    });
    await userEvent.click(age);
    expect(rowAt(0)?.textContent).toContain("prod-pod-0");
    await userEvent.click(age);
    expect(rowAt(0)?.textContent).toContain("prod-pod-2");
  });

  /**
   * One event changing is one row's work: no row it did not touch is a new
   * object, nothing is sorted again, and the one that happened again stands
   * on top. Fails if a batch rebuilds the feed, or if an event that happened
   * again stays where it was.
   */
  it("puts an event that happened again on top and leaves every other row as it was", async () => {
    const { client } = await watched();
    burst(Array.from({ length: 50 }, (_, index) => dated("prod", index)));
    await waitFor(() =>
      expect(document.body.textContent).toContain("prod-pod-49")
    );
    const before = rowsOf(client);
    const again = {
      ...before[40],
      count: 2,
      lastTimestamp: new Date(BASE + 5000).toISOString(),
    };

    const sort = vi.spyOn(Array.prototype, "sort");
    send([{ op: "applied", resource: again }]);
    expect(sort).not.toHaveBeenCalled();
    sort.mockRestore();

    const after = rowsOf(client);
    expect(after[0]).toBe(again);
    expect(after.filter((row) => !before.includes(row))).toEqual([again]);
    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.indexOf("prod-pod-40")).toBeLessThan(
        text.indexOf("prod-pod-0")
      );
    });
  });

  /**
   * Stories fold the whole feed: redrawn on every batch, a busy cluster
   * redraws every card twenty times a second where the poll redrew them
   * once. Fails if the stories follow each batch, or stop following.
   */
  it("redraws the stories at most once a second however often the watch changes", async () => {
    let commits = 0;
    await renderWithRouter(
      <Profiler id="events" onRender={() => commits++}>
        <Events />
      </Profiler>,
      eventsAt("stories")
    );
    await waitFor(() =>
      expect(commands.resourceWatchSubscribed).toHaveBeenCalled()
    );
    const now = Date.now();
    const failing = (index: number): EventInfo => ({
      ...event("prod", index),
      type: "Warning",
      reason: "BackOff",
      message: "Back-off restarting failed container app",
      involvedObject: {
        kind: "Pod",
        name: `worker-${index}`,
        namespace: "prod",
        uid: null,
      },
      lastTimestamp: new Date(now - 60_000 + index * 1000).toISOString(),
    });
    burst([failing(0)]);
    await screen.findByRole("article", { name: /worker-0/ });

    commits = 0;
    for (let index = 1; index <= 12; index++) {
      send([{ op: "applied", resource: failing(index) }]);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(commits).toBeLessThanOrEqual(2);
    expect(
      await screen.findByRole(
        "article",
        { name: /worker-12/ },
        { timeout: 2000 }
      )
    ).toBeInTheDocument();
  });

  /** Fails if choosing Warnings asks the cluster again rather than cutting what the watch holds. */
  it("narrows to warnings without asking the cluster again", async () => {
    await watched();
    burst([
      { ...dated("prod", 0), type: "Warning", reason: "BackOff" },
      dated("prod", 1),
      dated("prod", 2),
    ]);
    await screen.findByText("1 warning event · 2 normal events");

    await userEvent.click(screen.getByRole("button", { name: "Warnings" }));
    expect(await screen.findByText("1 warning event")).toBeInTheDocument();
    expect(subscribeEventWatch).toHaveBeenCalledTimes(1);
    expect(listEvents).not.toHaveBeenCalled();
  });

  /**
   * Several namespaces are one stream, watched a namespace each by the
   * backend. Fails if the scope is narrowed to one or read cluster-wide.
   */
  it("watches the namespaces the reader chose as one stream", async () => {
    useClusterStore.setState({ namespaceScope: ["prod", "staging"] });
    await watched();
    expect(subscribeEventWatch).toHaveBeenCalledWith(["prod", "staging"]);
    burst([dated("prod", 1), dated("staging", 0)]);
    await waitFor(() =>
      expect(document.body.textContent).toContain("staging-pod-0")
    );
    expect(document.body.textContent).toContain("prod-pod-1");
    expect(listEvents).not.toHaveBeenCalled();
  });

  /**
   * The watch broke and the cluster then stopped answering: the events it
   * had stay, said to be from the last moment the cluster answered. Fails if
   * they are dropped for the error, or drawn under "live".
   */
  it("keeps the watch's events, marked old, when the watch fails and the poll that replaces it fails too", async () => {
    await watched();
    burst([dated("prod", 0), dated("prod", 1)]);
    await waitFor(() =>
      expect(document.body.textContent).toContain("prod-pod-1")
    );
    listEvents.mockRejectedValue(new Error("502 Bad Gateway"));

    send([{ op: "failed", resource: null }], "connection reset by peer");

    expect(
      await screen.findByText(/Could not read events just now/)
    ).toBeInTheDocument();
    expect(listEvents).toHaveBeenCalled();
    expect(document.body.textContent).toContain("prod-pod-1");
    expect(screen.getByText("read failing")).toBeInTheDocument();
    expect(screen.queryByText("live")).not.toBeInTheDocument();
  });

  /**
   * On Dana's failing cluster each retry flipped the header to "polling" and
   * hid the banner over the same old rows for as long as the attempt took.
   * Fails if a retry of a poll that never answered clears the failure
   * before a read does.
   */
  it("keeps saying the read is failing while a retry is out, until a read answers", async () => {
    await watched();
    burst([dated("prod", 0), dated("prod", 1)]);
    await waitFor(() =>
      expect(document.body.textContent).toContain("prod-pod-1")
    );
    listEvents.mockRejectedValue(new Error("502 Bad Gateway"));
    send([{ op: "failed", resource: null }], "connection reset by peer");
    await screen.findByText(/Could not read events just now/);

    let answer: (rows: EventInfo[]) => void = () => {};
    listEvents.mockImplementation(
      () => new Promise((resolve) => (answer = resolve))
    );
    const before = listEvents.mock.calls.length;
    await userEvent.click(
      screen.getByRole("button", { name: "Try the read again" })
    );
    await waitFor(() =>
      expect(listEvents.mock.calls.length).toBeGreaterThan(before)
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText("read failing")).toBeInTheDocument();
    expect(
      screen.getByText(/Could not read events just now/)
    ).toBeInTheDocument();

    await act(async () => answer([dated("prod", 0)]));
    await waitFor(() =>
      expect(screen.queryByText("read failing")).not.toBeInTheDocument()
    );
  });

  /**
   * Marco's token may list events in team-checkout only. The watch is
   * refused across the cluster, and the page then says what the list said
   * before the watch existed. Fails if a refused watch reads as no events.
   */
  it("says a refused watch's feed was refused, not that the scope is quiet", async () => {
    listEvents.mockRejectedValue(
      Object.assign(
        new Error(
          'events is forbidden: User "marco" cannot list resource "events" at the cluster scope'
        ),
        { code: "PERMISSION_DENIED" }
      )
    );
    await watched("stories");
    send(
      [{ op: "failed", resource: null }],
      'events is forbidden: User "marco" cannot watch resource "events" at the cluster scope'
    );

    expect(
      await screen.findByText(/across the whole cluster was refused/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/Nothing happened in/)).not.toBeInTheDocument();
  });
});

describe("a feed whose re-read fails", () => {
  /**
   * During the 502 outage one list kept its rows under "polling" and another
   * dropped them for the error. The feed follows the lists' rule: the events
   * it had stay, said to be from the last read that answered. Fails if they
   * are dropped for the error, or kept with the header still claiming a poll.
   */
  it("keeps the events it had, marked as from the last read that answered", async () => {
    listEvents.mockResolvedValue(feed("prod", 3));
    const { client } = await mount();
    await waitFor(() =>
      expect(document.body.textContent).toContain("prod-pod-0")
    );

    listEvents.mockRejectedValue(new Error("502 Bad Gateway"));
    await act(() => client.refetchQueries());

    expect(
      await screen.findByText(/Could not read events just now/)
    ).toBeInTheDocument();
    expect(document.body.textContent).toContain("prod-pod-0");
    expect(screen.getByText("read failing")).toBeInTheDocument();
    expect(screen.queryByText("polling")).not.toBeInTheDocument();
  });
});

describe("a feed across namespaces whose re-read fails", () => {
  /**
   * The lists keep their rows through a failed re-read and say since when;
   * the feed across two namespaces dropped all of them for one namespace's
   * 502. Fails if the fan-out drops the rows it had, or keeps them under
   * "polling".
   */
  it("keeps the events every namespace gave, marked as from the last read that answered", async () => {
    useClusterStore.setState({ namespaceScope: ["prod", "staging"] });
    listEvents.mockImplementation(async (filters) =>
      feed(filters?.namespace ?? "", 2)
    );
    const { client } = await mount();
    await waitFor(() =>
      expect(document.body.textContent).toContain("staging-pod-1")
    );

    listEvents.mockImplementation(async (filters) => {
      if (filters?.namespace === "staging") throw new Error("502 Bad Gateway");
      return feed("prod", 2);
    });
    await act(() => client.refetchQueries());

    expect(
      await screen.findByText(/Could not read events just now/)
    ).toBeInTheDocument();
    expect(document.body.textContent).toContain("staging-pod-1");
    expect(document.body.textContent).toContain("prod-pod-1");
    expect(screen.getByText("read failing")).toBeInTheDocument();
  });

  /**
   * A namespace that never answered has no old rows to keep: what the
   * others gave is not the scope's feed. Fails if a namespace refused from
   * the start is drawn as rows from an earlier read.
   */
  it("says a namespace that never answered was not read, rather than calling the rest old", async () => {
    useClusterStore.setState({ namespaceScope: ["prod", "staging"] });
    listEvents.mockImplementation(async (filters) => {
      if (filters?.namespace === "staging") throw new Error("502 Bad Gateway");
      return feed("prod", 2);
    });
    await mount();

    expect(
      await screen.findByText(/Could not read the events in/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/Could not read events just now/)).toBeNull();
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
   * Lena's "64 warnings" beside the Warnings filter's 122: the first counted
   * the warnings among the latest 500 events of every type, the second
   * every warning, since the filter narrows the read itself. Fails if a
   * count read inside the limit's cut does not say so, or a whole one does.
   */
  it("says the warnings it counts are among the latest 500 only where the read was cut", async () => {
    useClusterStore.setState({
      namespaceScope: ["shop"],
      currentNamespace: "shop",
    });
    const mixed = feed("shop", 500).map((row, index) =>
      index % 8 === 0 ? { ...row, type: "Warning" } : row
    );
    listEvents.mockImplementation(async (filters) =>
      filters?.event_type === "Warning"
        ? feed("shop", 122).map((row) => ({ ...row, type: "Warning" }))
        : mixed
    );
    await mount();
    expect(
      await screen.findByText(
        "63 warning events · 437 normal events · of the latest 500"
      )
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Warnings" }));
    expect(await screen.findByText("122 warning events")).toBeInTheDocument();
  }, 30_000);

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
      await screen.findByText(/500 normal events · of the latest 500/)
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
    const feeds = sort.mock.contexts.filter(
      (list) => (list as unknown[]).length === 100
    );
    expect(feeds).toEqual([]);
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

  /**
   * Marco's team-checkout Events: the header said "4 warning · 21 normal",
   * Event objects as kubectl lists them, while the stories said "276
   * events", the times one of them happened. Fails if the header leaves out
   * its unit and span, or a story counts occurrences in the header's unit.
   */
  it("counts Event objects in the header and occurrences on the story, each by name", async () => {
    const pod = "checkout-worker-6d9f7b8c4-q2x7m";
    const failing = {
      ...warning("team-checkout", pod, 0),
      reason: "Failed",
      message: 'Error: secret "checkout-db" not found',
      count: 276,
    };
    const normal = (index: number): EventInfo => ({
      ...event("team-checkout", index),
      reason: "Pulled",
      message: 'Container image "busybox:1.36" already present on machine',
      count: 1,
      involvedObject: {
        kind: "Pod",
        name: pod,
        namespace: "team-checkout",
        uid: null,
      },
      lastTimestamp: new Date(Date.now() - 60_000).toISOString(),
    });
    listEvents.mockResolvedValue([failing, normal(1), normal(2)]);
    await mount("stories");

    const card = await screen.findByRole("article", {
      name: /checkout-worker/,
    });
    expect(card.textContent).toContain("happened 278 times");
    expect(card.textContent).not.toMatch(/278 events/);
    expect(
      screen.getByText(
        "1 story · 1 warning event · 2 normal events · in the 1h window"
      )
    ).toBeInTheDocument();
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
   * Stories, the windows, the search and the limit sat over the refusal as
   * though there were events to arrange. Fails if they are drawn over a feed
   * nothing was read from.
   */
  it("draws no view or filter controls over a feed it could not read", async () => {
    listEvents.mockRejectedValue(
      new Error(
        'events is forbidden: User "marco" cannot list resource "events"'
      )
    );
    await mount("stories");
    await screen.findByText(/across the whole cluster was refused/);

    expect(screen.queryByRole("tab", { name: "Stories" })).toBeNull();
    expect(screen.queryByPlaceholderText(/filter events/i)).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "Events fetched" })
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
