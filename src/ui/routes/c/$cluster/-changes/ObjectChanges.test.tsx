import { screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { queryKeys } from "@/lib/query-keys";
import { forgetRefusals } from "@/lib/refusals";
import { formatWhen } from "@/lib/utils";
import type {
  ObservedSpan,
  TimelinePage,
  TimelineRow,
} from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter, testQueryClient } from "@/test/render";
import { layOutVirtualLists } from "@/test/virtual-layout";
import { ObjectChanges } from "./ObjectChanges";

const LEDGER = {
  kind: "Deployment" as const,
  name: "ledger",
  namespace: "team-blind",
  labels: {},
  annotations: {},
  createdAt: null,
};

/** A page of the timeline as the backend answers it. */
function page(over: Partial<TimelinePage> = {}): TimelinePage {
  return {
    rows: [],
    more: false,
    newest: 0,
    spans: { followed: [], meta: [] },
    letGo: { changes: null, warnings: null, normal: null },
    keeping: { says: "kept" },
    unreadable: 0,
    ...over,
  };
}

const span = (over: Partial<ObservedSpan>): ObservedSpan => ({
  from: 0,
  seenAt: 0,
  to: null,
  unwatched: [],
  unwatchedIn: [],
  scope: [],
  kinds: ["Deployment", "Service"],
  ...over,
});

/** Every list and get answers empty, and the timeline with `timeline`. */
function answering(
  timeline: TimelinePage,
  also?: (command: string) => unknown
) {
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    const said = also?.(command);
    if (said !== undefined) return said;
    if (command === "timeline_read") return timeline;
    return command.startsWith("list_") || command.startsWith("get_")
      ? []
      : undefined;
  });
}

let unlaid = () => {};
beforeEach(() => {
  forgetRefusals();
  useClusterStore.setState({ isConnected: true, currentContext: "prod" });
  unlaid = layOutVirtualLists();
});
afterEach(() => unlaid());

/**
 * Sam opened big-pull's page before applying it, and its Revisions kept the
 * NotFound from then beside the Deployment Ready. Fails if the timeline says
 * the revisions could not be read once the page has read the Deployment, or
 * does not ask for them again.
 */
it("reads a NotFound from before the Deployment was made as still reading, and asks again", async () => {
  let asked = 0;
  answering(page(), (command) => {
    if (command !== "get_deployment_replicasets") return undefined;
    asked += 1;
    return asked === 1
      ? Promise.reject({
          code: "NOT_FOUND",
          message: 'deployments.apps "ledger" not found',
        })
      : new Promise(() => {});
  });
  const client = testQueryClient();
  await renderWithRouter(<ObjectChanges subject={LEDGER} />, {
    at: "/c/prod",
    client,
  });
  expect(
    await screen.findByText(/The revisions could not be read/)
  ).toBeInTheDocument();

  client.setQueryData(queryKeys.detail("Deployment", "team-blind", "ledger"), {
    uid: "uid",
  });

  await waitFor(() =>
    expect(screen.queryByText(/The revisions could not be read/)).toBeNull()
  );
  await waitFor(() => expect(asked).toBe(2));
});

/**
 * The same stretch on a Deployment's own tab read "since" for up to 30 s
 * after the next watch began, while the page's clock waited for its next
 * half minute. Fails if the stretch's end waits for that clock.
 */
it("ends a stretch the moment the next watch begins, not at the next tick of the page's clock", async () => {
  const at = Date.parse("2026-10-12T11:44:20Z");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
  try {
    const blind = ["team-blind"];
    answering(
      page({
        spans: {
          followed: [
            span({
              from: at - 10 * 60_000,
              seenAt: at - 2 * 60_000,
              to: at - 2 * 60_000,
              scope: blind,
            }),
            span({
              from: at - 2 * 60_000,
              seenAt: at - 10_000,
              to: at - 10_000,
              scope: ["team-checkout"],
            }),
            span({ from: at - 10_000, seenAt: at - 10_000, scope: blind }),
          ],
          meta: [],
        },
      })
    );
    await renderWithRouter(<ObjectChanges subject={LEDGER} />, {
      at: "/c/prod",
    });
    const ended = `Watching other namespaces, not this one, ${formatWhen(at - 2 * 60_000, "moment")} to ${formatWhen(at - 10_000, "moment")}`;
    expect(await screen.findByText(ended)).toBeInTheDocument();
    expect(screen.queryByText(/not this one, since/)).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

/**
 * A rollout made revision 8 while the tab was open: the header said 8 and
 * this tab went on marking 7 current for up to 30 s, so 7 had no Roll back
 * and a rollback to 6 was previewed against 7. Fails if the tab reads the
 * revisions slower than the page around it reads the same fact.
 */
it("reads the revisions again within seconds, as the page's header does", async () => {
  let asked = 0;
  answering(page(), (command) => {
    if (command === "get_deployment_replicasets") asked += 1;
    return undefined;
  });
  await renderWithRouter(<ObjectChanges subject={LEDGER} />, {
    at: "/c/prod",
  });
  await waitFor(() => expect(asked).toBe(1));
  await waitFor(() => expect(asked).toBeGreaterThan(1), { timeout: 6000 });
}, 10_000);

const change = (over: Partial<TimelineRow>): TimelineRow => ({
  id: "1",
  seq: 1,
  at: Date.now() - 60_000,
  kind: "Service",
  group: "",
  namespace: "shop",
  name: "web",
  what: {
    says: "changed",
    fields: [
      {
        says: "moved",
        path: "spec.selector.app",
        from: "web-v1",
        to: "web-v2",
      },
      { says: "notKept", path: "metadata.annotations[x]", was: true, is: true },
    ],
    more: 0,
    before: null,
  },
  atRelist: false,
  ...over,
});

/**
 * Every object page has the tab, not only a workload's. Fails if a Service's
 * recorded change is not drawn in its own field paths, or a value the
 * timeline never kept reads as one that did not change.
 */
it("draws a Service's recorded change in its own field paths", async () => {
  answering(
    page({
      rows: [change({})],
      spans: { followed: [span({ from: Date.now() - 3_600_000 })], meta: [] },
    })
  );
  await renderWithRouter(
    <ObjectChanges
      subject={{
        kind: "Service",
        name: "web",
        namespace: "shop",
        createdAt: null,
      }}
    />,
    { at: "/c/prod" }
  );
  expect(await screen.findByText("spec.selector.app")).toBeInTheDocument();
  expect(screen.getByText("web-v2")).toBeInTheDocument();
  expect(
    screen.getByText("metadata.annotations[x] changed (values are not kept)")
  ).toBeInTheDocument();
});

/**
 * A change to a Deployment's template names the revision it replaced.
 * Fails if "Roll back to before this" is not offered on it, or is offered
 * on a change the object named no revision for.
 */
it("offers to roll back to the revision before a template change", async () => {
  const replicaSet = (revision: string, current: boolean) => ({
    uid: `rs-${revision}`,
    name: `ledger-${revision}`,
    revision,
    currentRevision: current ? revision : "4",
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    annotations: {},
    containers: [],
    initContainers: [],
    templateAnnotations: {},
    template: {},
  });
  answering(
    page({
      rows: [
        change({
          id: "2",
          seq: 2,
          kind: "Deployment",
          group: "apps",
          namespace: "team-blind",
          name: "ledger",
          what: {
            says: "changed",
            fields: [
              {
                says: "moved",
                path: "spec.template.spec.containers[app].image",
                from: "a",
                to: "b",
              },
            ],
            more: 0,
            before: "3",
          },
        }),
        change({
          id: "1",
          seq: 1,
          at: Date.now() - 120_000,
          kind: "Deployment",
          group: "apps",
          namespace: "team-blind",
          name: "ledger",
          what: {
            says: "changed",
            fields: [
              { says: "moved", path: "spec.replicas", from: "1", to: "2" },
            ],
            more: 0,
            before: null,
          },
        }),
      ],
    }),
    (command) =>
      command === "get_deployment_replicasets"
        ? [replicaSet("3", false), replicaSet("4", true)]
        : command === "check_access"
          ? { allowed: true, reason: null }
          : undefined
  );
  await renderWithRouter(<ObjectChanges subject={LEDGER} />, {
    at: "/c/prod",
  });
  expect(await screen.findAllByText("Roll back to before this")).toHaveLength(
    1
  );
});

/**
 * A timeline that could not be read holds no spans, and the tab drew the
 * whole week as "Not observed" beside the failure. Fails if a failed read
 * claims anything about when this app was watching.
 */
it("draws no stretch as watched or unwatched from a timeline it could not read", async () => {
  answering(page(), (command) =>
    command === "timeline_read"
      ? Promise.reject(new Error("disk refused"))
      : undefined
  );
  await renderWithRouter(<ObjectChanges subject={LEDGER} />, { at: "/c/prod" });
  expect(
    await screen.findByText(/^The timeline could not be read: /)
  ).toBeInTheDocument();
  expect(screen.queryByText(/^Not observed /)).toBeNull();
});
