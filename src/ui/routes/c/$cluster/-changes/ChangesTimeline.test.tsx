import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

import type { ChangeItem, ChangeRow, Revision } from "@/lib/changes";
import type { AccessQuery } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { useLocaleStore } from "@/stores/localeStore";
import { renderWithRouter } from "@/test/render";
import { layOutVirtualLists } from "@/test/virtual-layout";
import { useRollback } from "../-object/useRollback";
import { ChangesTimeline } from "./ChangesTimeline";

const T0 = Date.parse("2026-09-08T02:10:00Z");
const HOUR = 60 * 60_000;

/** One recorded change of Deployment shop/api. */
function change(
  id: string,
  at: number,
  path: string,
  from: string,
  to: string
): ChangeRow {
  return {
    id,
    seq: at,
    at,
    kind: "Deployment",
    group: "apps",
    namespace: "shop",
    name: "api",
    what: {
      says: "changed",
      fields: [{ says: "moved", path, from, to }],
      more: 0,
      before: null,
    },
    atRelist: false,
  };
}

let unlaid = () => {};
beforeEach(() => {
  unlaid = layOutVirtualLists();
});
afterEach(() => unlaid());

function mount(items: ChangeItem[], since?: number) {
  return renderWithRouter(
    <ChangesTimeline items={items} since={since} showObject />,
    { at: "/c/dev", route: "/c/$cluster" }
  );
}

describe("ChangesTimeline", () => {
  /**
   * A Helm revision whose secret would not decode has a number and nothing
   * else. Fails if the timeline prints it as a revision of no chart.
   */
  it("says of a Helm revision that could not be read that it was not", async () => {
    await mount([
      {
        kind: "helm",
        at: null,
        revision: {
          revision: 5,
          updated: "",
          status: "",
          chart: "",
          appVersion: null,
          description: null,
          unreadable: "gzip: unexpected end of file",
        },
      },
    ]);
    expect(
      screen.getByText("Helm revision 5: could not be read")
    ).toHaveAttribute("title", "gzip: unexpected end of file");
  });

  /** A gap is drawn as its own row, in words, not as an empty stretch a reader would read as calm. */
  it("draws a gap as a gap", async () => {
    await mount([
      {
        kind: "journal",
        unplaced: false,
        at: T0 + 6 * HOUR,
        row: change(
          "j",
          T0 + 6 * HOUR,
          "spec.template.spec.containers[app].image",
          "app:1",
          "app:2"
        ),
      },
      {
        kind: "gap",
        at: T0 + 5.5 * HOUR,
        gap: { from: T0, to: T0 + 5.5 * HOUR },
      },
    ]);
    const note = screen.getByRole("note");
    expect(note.textContent).toMatch(/^Not observed /);
    expect(document.body.textContent).toContain("image app:1 → app:2");
  });

  /**
   * A past stretch whose watch was refused a kind read "Watched … nothing
   * here changed" and nothing else. Fails if the row stops saying, beside
   * the quiet, what nobody was let watch.
   */
  it("says beside a quiet stretch what its watch was refused", async () => {
    await mount([
      {
        kind: "watched",
        quiet: true,
        at: T0 + HOUR,
        gap: { from: T0, to: T0 + HOUR },
        refused: { unwatched: ["DaemonSet"], scope: ["shop"] },
      },
    ]);
    expect(
      screen.getByText(/^Watched .+: nothing here changed$/)
    ).toBeVisible();
    expect(
      screen.getByText("DaemonSet not watched in shop: the cluster refused")
    ).toBeVisible();
  });

  /**
   * A stretch that recorded rows is not a quiet one. Fails if the row saying
   * what such a stretch was refused calls it quiet, or drops the refusal.
   */
  it("says what a stretch with rows was refused without calling it quiet", async () => {
    await mount([
      {
        kind: "watched",
        quiet: false,
        at: T0 + HOUR,
        gap: { from: T0, to: T0 + HOUR },
        refused: { unwatched: ["DaemonSet"], scope: ["shop"] },
      },
    ]);
    const refused = screen.getByText(
      "DaemonSet not watched in shop: the cluster refused"
    );
    expect(refused).toBeVisible();
    expect(refused.parentElement?.textContent).toMatch(/^Watched .+ to /);
    expect(screen.queryByText(/nothing here changed/)).toBeNull();
  });

  /**
   * Lena switched the scope to another namespace for 57 seconds and came
   * back to "Вне наблюдаемых пространств имён 57 секунд в 7 окт., 09:32",
   * which says where the app was not and nothing of where it was. Fails if
   * the quiet row stops saying what the app watched, or goes amber.
   */
  it("says in Russian that the app watched other namespaces for that stretch, in a quiet row", async () => {
    useLocaleStore.setState({ choice: "ru" });
    try {
      await mount([
        {
          kind: "gap",
          at: T0,
          gap: { from: T0, to: T0 + 57_000, elsewhere: true },
        },
      ]);
      const note = screen.getByRole("note");
      expect(note.textContent).toMatch(
        /^В течение 57 секунд \(.+\) следили за другими пространствами имён, а за этим нет$/
      );
      expect(note).toHaveClass("text-fg-mut");
      expect(note).not.toHaveClass("text-warn");
    } finally {
      useLocaleStore.setState({ choice: null });
    }
  });

  it("marks what happened after the moment the reader came from", async () => {
    await mount(
      [
        {
          kind: "journal",
          unplaced: false,
          at: T0 + 2 * HOUR,
          row: change("new", T0 + 2 * HOUR, "spec.replicas", "2", "3"),
        },
        {
          kind: "journal",
          unplaced: false,
          at: T0,
          row: change("old", T0, "spec.replicas", "1", "2"),
        },
      ],
      T0 + HOUR
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveAttribute("data-after-since", "true");
    expect(rows[1]).not.toHaveAttribute("data-after-since");
  });

  it("says the oldest revision has nothing to compare with", async () => {
    await mount([
      {
        kind: "revision",
        at: T0,
        against: { state: "oldest" },
        readopted: false,
        revision: {
          id: "r1",
          number: 1,
          name: "api-1",
          current: true,
          at: new Date(T0).toISOString(),
          changeCause: "first deploy",
          containers: [],
          initContainers: [],
          templateAnnotations: {},
          templateKnown: true,
          template: null,
        },
      },
    ]);
    expect(document.body.textContent).toContain("revision 1");
    expect(document.body.textContent).toContain("first deploy");
    expect(document.body.textContent).toContain("oldest known");
  });

  /**
   * The thesis applied to a diff: "no difference in what we compared" must
   * not read as "no difference". A change outside the named fields is
   * counted, and one click shows it.
   */
  it("says other fields differ, and shows them on asking, instead of saying nothing changed", async () => {
    await mount([
      {
        kind: "revision",
        at: T0,
        readopted: false,
        against: {
          state: "compared",
          missing: 0,
          changes: [],
          others: [
            {
              container: null,
              field: "spec.containers[app].command",
              from: '["nginx"]',
              to: '["nginx","-g","daemon off;"]',
            },
          ],
        },
        revision: {
          id: "r2",
          number: 2,
          name: "api-2",
          current: true,
          at: new Date(T0).toISOString(),
          changeCause: null,
          containers: [],
          initContainers: [],
          templateAnnotations: {},
          templateKnown: true,
          template: null,
        },
      },
    ]);
    expect(document.body.textContent).not.toContain("same template");
    const toggle = screen.getByRole("button", {
      name: /1 other field differs/,
    });
    expect(document.body.textContent).not.toContain(
      "spec.containers[app].command"
    );
    toggle.click();
    expect(
      await screen.findByText("spec.containers[app].command")
    ).toBeInTheDocument();
  });

  /** An empty named diff without the whole templates is a warning that the rest was not read. */
  it("warns that the rest was not compared when the whole templates were not read", async () => {
    await mount([
      {
        kind: "revision",
        at: T0,
        readopted: false,
        against: { state: "compared", missing: 0, changes: [], others: null },
        revision: {
          id: "r2",
          number: 2,
          name: "api-2",
          current: true,
          at: new Date(T0).toISOString(),
          changeCause: null,
          containers: [],
          initContainers: [],
          templateAnnotations: {},
          templateKnown: true,
          template: null,
        },
      },
    ]);
    expect(
      screen.getByText(/the rest of the template could not be compared/)
    ).toHaveClass("text-warn");
  });

  /** Only an older revision whose template was read can be rolled back to. */
  it("offers a rollback on an older revision and not on the current one", async () => {
    const base = {
      changeCause: null,
      containers: [],
      initContainers: [],
      templateAnnotations: {},
      templateKnown: true,
      template: null,
      at: new Date(T0).toISOString(),
    };
    const offered: number[] = [];
    await renderWithRouter(
      <ChangesTimeline
        items={[
          {
            kind: "revision",
            at: T0 + HOUR,
            readopted: false,
            against: { state: "oldest" },
            revision: {
              ...base,
              id: "r2",
              number: 2,
              name: "api-2",
              current: true,
            },
          },
          {
            kind: "revision",
            at: T0,
            readopted: false,
            against: { state: "oldest" },
            revision: {
              ...base,
              id: "r1",
              number: 1,
              name: "api-1",
              current: false,
            },
          },
        ]}
        onRollback={(revision) => offered.push(revision.number ?? -1)}
      />,
      { at: "/c/dev", route: "/c/$cluster" }
    );
    const buttons = screen.getAllByRole("button", {
      name: /Roll back to this revision/,
    });
    expect(buttons).toHaveLength(1);
    buttons[0].click();
    expect(offered).toEqual([1]);
  });

  /** Where the object began is a row of its own, so the timeline does not read as starting from nothing. */
  it("marks the object's creation", async () => {
    await mount([{ kind: "created", at: T0 }]);
    expect(document.body.textContent).toContain(
      "created; nothing before this belongs to it"
    );
  });
});

describe("a rollback the cluster will not take from this reader", () => {
  const revision = (number: number, current: boolean): Revision => ({
    changeCause: null,
    containers: [],
    initContainers: [],
    templateAnnotations: {},
    templateKnown: true,
    template: null,
    at: new Date(T0 + number * HOUR).toISOString(),
    id: `r${number}`,
    number,
    name: `api-${number}`,
    current,
  });
  const revisions = [revision(2, true), revision(1, false)];

  function Timeline() {
    const rollback = useRollback({
      subject: { kind: "Deployment", name: "api", namespace: "shop" },
      revisions,
      intercept: null,
    });
    return (
      <>
        <ChangesTimeline
          items={revisions.map((r) => ({
            kind: "revision",
            at: Date.parse(r.at!),
            readopted: false,
            against: { state: "oldest" },
            revision: r,
          }))}
          onRollback={rollback.offer}
          rollbackDenied={rollback.denied}
        />
        {rollback.dialog}
      </>
    );
  }

  /**
   * "Roll back to this" opened a confirmation whose rollback the cluster
   * refuses. Fails if it stays live while can-i patch deployments says no.
   */
  it("greys Roll back to this with the can-i question and opens nothing", async () => {
    useClusterStore.setState((s) => ({
      currentContext: "dev",
      isConnected: true,
      connectionAttemptId: s.connectionAttemptId + 1,
    }));
    vi.mocked(invoke).mockImplementation(async (command: string, args) =>
      command === "check_access"
        ? (args as { queries: AccessQuery[] }).queries.map((query) => ({
            ...query,
            allowed: false,
          }))
        : undefined
    );
    await renderWithRouter(<Timeline />, {
      at: "/c/dev",
      route: "/c/$cluster",
    });
    const back = () =>
      screen.getByRole("button", { name: /Roll back to this revision/ });
    await waitFor(() =>
      expect(back()).toHaveAttribute("aria-disabled", "true")
    );
    fireEvent.click(back());
    expect(screen.queryByRole("dialog")).toBeNull();
    vi.mocked(invoke).mockImplementation(async () => undefined);
  });

  /**
   * Roll back to this opened its confirmation with the Roll back button
   * focused, so a stray Enter rolled the workload back. Fails if Cancel is
   * not focused on opening, or if Enter sends the rollback.
   */
  it("opens with the cursor on Cancel, so Enter rolls nothing back", async () => {
    useClusterStore.setState((s) => ({
      currentContext: "dev",
      isConnected: true,
      connectionAttemptId: s.connectionAttemptId + 1,
    }));
    vi.mocked(invoke).mockImplementation(async (command: string, args) =>
      command === "check_access"
        ? (args as { queries: AccessQuery[] }).queries.map((query) => ({
            ...query,
            allowed: true,
          }))
        : undefined
    );
    const user = userEvent.setup();
    await renderWithRouter(<Timeline />, {
      at: "/c/dev",
      route: "/c/$cluster",
    });
    await user.click(
      screen.getByRole("button", { name: /Roll back to this revision/ })
    );
    const dialog = await screen.findByRole("dialog");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      within(dialog).getByRole("button", { name: "Cancel" })
    ).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      vi.mocked(invoke).mock.calls.map(([command]) => command)
    ).not.toContain("rollback_workload");
    vi.mocked(invoke).mockImplementation(async () => undefined);
  });
});

describe("a week of rows", () => {
  /**
   * A busy cluster's week is thousands of rows; drawn whole, scrolling the
   * page laid all of them out. Fails if rows out of view are in the document.
   */
  it("draws only the rows in view", async () => {
    const items: ChangeItem[] = Array.from({ length: 2000 }, (_, n) => ({
      kind: "journal" as const,
      unplaced: false,
      at: T0 - n * 60_000,
      row: change(String(n), T0 - n * 60_000, "spec.replicas", "1", "2"),
    }));
    await mount(items);
    const drawn = screen.getAllByRole("listitem").length;
    expect(drawn).toBeGreaterThan(10);
    expect(drawn).toBeLessThan(100);
  });

  /** Fails if the reader nears the last row read and older ones are never asked for. */
  it("asks for older rows when the reader nears the last one read", async () => {
    const onEnd = vi.fn();
    const items: ChangeItem[] = Array.from({ length: 5 }, (_, n) => ({
      kind: "journal" as const,
      unplaced: false,
      at: T0 - n * 60_000,
      row: change(String(n), T0 - n * 60_000, "spec.replicas", "1", "2"),
    }));
    await renderWithRouter(<ChangesTimeline items={items} onEnd={onEnd} />, {
      at: "/c/dev",
      route: "/c/$cluster",
    });
    expect(onEnd).toHaveBeenCalled();
  });
});

describe("the rows the timeline recorded", () => {
  /** The cluster's words, untranslated, with the series counted. Fails if a repeat reads as one event. */
  it("draws an event series with its reason, its words and its count", async () => {
    const at = T0;
    await mount([
      {
        kind: "event",
        unplaced: false,
        at,
        row: { ...change("e", at, "x", "a", "b"), kind: "Pod" },
        event: {
          name: "api-1.1",
          namespace: "shop",
          uid: "e",
          type: "Warning",
          reason: "BackOff",
          message: "Back-off restarting failed container app",
          source: "kubelet",
          involvedObject: {
            kind: "Pod",
            name: "api-1",
            namespace: "shop",
            uid: "p",
          },
          count: 14,
          firstTimestamp: new Date(at - HOUR).toISOString(),
          lastTimestamp: new Date(at).toISOString(),
        },
      },
    ]);
    expect(screen.getByText("BackOff")).toBeInTheDocument();
    expect(
      screen.getByText("Back-off restarting failed container app")
    ).toBeInTheDocument();
    expect(screen.getByText("×14")).toHaveAttribute("title");
  });

  /** An event series no read placed: fails if it is drawn without saying it may be another cluster's, or a placed one says it. */
  it("says of an event series no read placed that it may be another cluster's", async () => {
    const series = (id: string, unplaced: boolean): ChangeItem => ({
      kind: "event",
      unplaced,
      at: T0,
      row: { ...change(id, T0, "x", "a", "b"), kind: "Pod" },
      event: {
        name: `api-1.${id}`,
        namespace: "shop",
        uid: id,
        type: "Warning",
        reason: unplaced ? "Unplaced" : "Placed",
        message: null,
        source: "kubelet",
        involvedObject: {
          kind: "Pod",
          name: "api-1",
          namespace: "shop",
          uid: "p",
        },
        count: 1,
        firstTimestamp: null,
        lastTimestamp: new Date(T0).toISOString(),
      },
    });
    await mount([series("u", true), series("p", false)]);
    expect(
      screen.getAllByText(/^Recorded under this name while which cluster/)
    ).toHaveLength(1);
  });

  /** Rows let go at a bound are said as such: fails if their stretch has no row. */
  it("says where older rows were let go", async () => {
    await mount([
      {
        kind: "letGo",
        at: T0,
        of: "warnings",
        letGo: { before: T0, cleared: false },
      },
    ]);
    expect(screen.getByTestId("changes-let-go").textContent).toMatch(
      /^Older warnings were let go to stay under the limit; kept from /
    );
  });

  /** A change of many fields names the first and folds the rest behind their count, and none is lost. */
  it("folds the fields past the first behind their count, and shows them on asking", async () => {
    const row = change("m", T0, "spec.a", "1", "2");
    row.what = {
      says: "changed",
      fields: ["a", "b", "c", "d", "e"].map((name) => ({
        says: "moved" as const,
        path: `spec.${name}`,
        from: "1",
        to: "2",
      })),
      more: 0,
      before: null,
    };
    await mount([{ kind: "journal", unplaced: false, at: T0, row }]);
    expect(screen.queryByText("spec.d")).toBeNull();
    await userEvent.click(screen.getByText("and 2 more fields"));
    expect(screen.getByText("spec.e")).toBeInTheDocument();
  });

  /**
   * On a page of many objects, "roll back to before this" leads to the
   * object's own tab, marked from that moment, where the dialog is. Fails if
   * a template change offers no way there, or a scale offers one.
   */
  it("leads from a template change to its object's tab, marked from that moment", async () => {
    const rolled = change(
      "r",
      T0,
      "spec.template.spec.containers[app].image",
      "a",
      "b"
    );
    rolled.what = { ...rolled.what, before: "3" } as ChangeRow["what"];
    const scaled = change("s", T0 - HOUR, "spec.replicas", "1", "2");
    await mount([
      { kind: "journal", unplaced: false, at: T0, row: rolled },
      { kind: "journal", unplaced: false, at: T0 - HOUR, row: scaled },
    ]);
    const links = screen.getAllByRole("link", {
      name: "Roll back to before this…",
    });
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toContain("tab=changes");
    expect(links[0].getAttribute("href")).toContain(
      `since=${encodeURIComponent(new Date(T0).toISOString())}`
    );
  });
});
