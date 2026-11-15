import { describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { EventInfo } from "@/generated/types";
import type { ObjectEventsQuery } from "@/hooks/useObjectEvents";
import { renderWithRouter } from "@/test/render";
import { ObjectEventsBody } from "./ObjectEventsBody";
import { ObjectUnreadContext } from "./object-unread";

const REFUSED =
  'replicasets.apps is forbidden: User "jane@example.com" cannot list resource "replicasets" in API group "apps" in the namespace "shop"';

const about = (pod: string, reason: string, at: number): EventInfo => ({
  name: `${pod}.${reason}`,
  namespace: "shop",
  uid: `${pod}-${reason}`,
  type: "Normal",
  reason,
  message: `${reason}, number ${at}`,
  source: null,
  involvedObject: { kind: "Pod", name: pod, namespace: "shop", uid: null },
  count: 1,
  firstTimestamp: null,
  lastTimestamp: new Date(Date.UTC(2026, 9, 9, 10, 0, at)).toISOString(),
});

const answered = (
  data: EventInfo[],
  ownedUnread: ObjectEventsQuery["ownedUnread"] = null
) =>
  ({
    subject: {
      kind: data[0]?.involvedObject.kind ?? "Pod",
      name: data[0]?.involvedObject.name ?? "",
      namespace: "shop",
    },
    data,
    error: null,
    dataUpdatedAt: Date.now(),
    refetch: vi.fn(),
    ownedUnread,
  }) as unknown as ObjectEventsQuery;

const body = (data: EventInfo[]) => (
  <ObjectEventsBody query={answered(data)} everyObject={false} />
);

const reasons = () =>
  screen.getAllByText(/, number /).map((message) => message.textContent);

describe("one object's events, live", () => {
  /**
   * A newest-first list moves every row down when an event arrives, so a
   * click aimed at one lands on another. Fails if a new answer moves the
   * rows while the pointer is on them, or what arrived cannot be reached.
   */
  it("holds its rows while the pointer is on them and offers what arrived", async () => {
    const first = [about("web-1", "Started", 2), about("web-1", "Pulled", 1)];
    const { rerender } = await renderWithRouter(body(first));
    await userEvent.hover(screen.getByText("Started, number 2"));

    await rerender(body([about("web-1", "Killing", 3), ...first]));
    expect(reasons()).toEqual(["Started, number 2", "Pulled, number 1"]);

    await userEvent.click(
      screen.getByRole("button", { name: "Show 1 update" })
    );
    expect(reasons()).toEqual([
      "Killing, number 3",
      "Started, number 2",
      "Pulled, number 1",
    ]);
  });

  /**
   * A link inside the list opens another object with the pointer still on
   * it. Fails if the rows held for one object are drawn under another's.
   */
  it("draws another object's events at once, pointer or not", async () => {
    const { rerender } = await renderWithRouter(
      body([about("web-1", "Started", 2)])
    );
    await userEvent.hover(screen.getByText("Started, number 2"));

    await rerender(body([about("api-2", "Pulled", 5)]));
    expect(reasons()).toEqual(["Pulled, number 5"]);
    expect(
      screen.queryByRole("button", { name: /Show \d+ update/ })
    ).toBeNull();
  });

  /** Fails if a warning a Deployment carries from its ReplicaSet is drawn as if it were about the Deployment, or its own rows grow a name. */
  it("names the ReplicaSet on a warning it carries, and not the object on its own rows", async () => {
    const own = about("web", "ScalingReplicaSet", 1);
    const refused: EventInfo = {
      ...about("web-7d9f", "FailedCreate", 2),
      involvedObject: {
        kind: "ReplicaSet",
        name: "web-7d9f",
        namespace: "shop",
        uid: null,
      },
    };
    await renderWithRouter(
      <ObjectEventsBody
        query={answered([
          {
            ...own,
            involvedObject: { ...own.involvedObject, kind: "Deployment" },
          },
          refused,
        ])}
        everyObject={false}
      />
    );
    expect(
      screen.getByRole("link", { name: "ReplicaSet web-7d9f" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Deployment web" })).toBeNull();
  });

  /**
   * A refused read of them was an amber triangle over mono text.
   * Fails if the warnings that could not be read go unsaid under the rows
   * that could, or a refusal is not the framed lock with the rule to ask for.
   */
  it("says under its own rows that its ReplicaSets' warnings were refused, with the rule to ask for", async () => {
    await renderWithRouter(
      <ObjectEventsBody
        query={answered([about("web", "Started", 1)], {
          unread: "replicaSetWarningsUnread",
          error: new Error(REFUSED),
        })}
        everyObject={false}
      />
    );
    const line = screen.getByTestId("owned-events-unread");
    expect(line).toHaveAttribute("data-read", "refused");
    expect(line).toHaveTextContent(
      "Could not read the events of its ReplicaSets, where a failure to create its pods is written."
    );
    expect(
      screen.getByRole("button", { name: /Copy the rule to ask for/ })
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Try the read again/ })
    ).toBeVisible();
  });

  /**
   * Under the peek's own refused read the line repeated the
   * notice above it with its own, older cause. Fails if a part read through
   * an unread object draws its own box instead of one line worded from the
   * object's failure now.
   */
  it("waits on the object in one quiet line while the object itself is unread", async () => {
    await renderWithRouter(
      <ObjectUnreadContext.Provider
        value={{
          kind: "Deployment",
          name: "web",
          failure: new Error("etcdserver: request timed out"),
        }}
      >
        <ObjectEventsBody
          query={answered([about("web", "Started", 1)], {
            unread: "replicaSetWarningsUnread",
            error: new Error(REFUSED),
          })}
          everyObject={false}
        />
      </ObjectUnreadContext.Provider>
    );
    expect(screen.getByTestId("waits-on-object")).toHaveTextContent(
      "Read through Deployment web, which could not be read just now."
    );
    expect(
      screen.queryByRole("button", { name: /Try the read again/ })
    ).toBeNull();
    expect(screen.queryByText(/forbidden/)).toBeNull();
  });
});
