import { describe, expect, it, vi } from "vite-plus/test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

import type { ChangeItem, Revision } from "@/lib/changes";
import type { AccessQuery } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { useRollback } from "../-object/useRollback";
import { ChangesTimeline } from "./ChangesTimeline";

const T0 = Date.parse("2026-09-08T02:10:00Z");
const HOUR = 60 * 60_000;

function mount(items: ChangeItem[], since?: number) {
  return renderWithRouter(
    <ChangesTimeline items={items} since={since} showObject />,
    { at: "/c/dev", route: "/c/$cluster" }
  );
}

describe("ChangesTimeline", () => {
  /** A gap is drawn as its own row, in words, not as an empty stretch a reader would read as calm. */
  it("draws a gap as a gap", async () => {
    await mount([
      {
        kind: "journal",
        at: T0 + 6 * HOUR,
        entry: {
          id: "j",
          context: "dev",
          kind: "Deployment",
          namespace: "shop",
          name: "api",
          at: T0 + 6 * HOUR,
          field: "image",
          key: "0",
          from: "app:1",
          to: "app:2",
        },
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

  it("marks what happened after the moment the reader came from", async () => {
    await mount(
      [
        {
          kind: "journal",
          at: T0 + 2 * HOUR,
          entry: {
            id: "new",
            context: "dev",
            kind: "Deployment",
            namespace: "shop",
            name: "api",
            at: T0 + 2 * HOUR,
            field: "replicas",
            key: null,
            from: "2",
            to: "3",
          },
        },
        {
          kind: "journal",
          at: T0,
          entry: {
            id: "old",
            context: "dev",
            kind: "Deployment",
            namespace: "shop",
            name: "api",
            at: T0,
            field: "replicas",
            key: null,
            from: "1",
            to: "2",
          },
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
});
