import { describe, expect, it } from "vite-plus/test";
import { fireEvent, screen } from "@testing-library/react";

import type { EventInfo } from "@/generated/types";
import {
  storiesOf,
  subjectKey,
  WINDOW_MS,
  withGone,
  type StoryOptions,
} from "@/lib/event-stories";
import { useLocaleStore } from "@/stores/localeStore";
import { queryKeys } from "@/lib/query-keys";
import { renderWithRouter, testQueryClient } from "@/test/render";
import { StoryCard } from "./StoryCard";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const HOUR = WINDOW_MS["1h"];

const backOff: EventInfo = {
  name: "web-0.1",
  namespace: "shop",
  uid: "web-0.1",
  type: "Warning",
  reason: "BackOff",
  message: "Back-off restarting failed container app",
  source: "kubelet",
  involvedObject: { kind: "Pod", name: "web-0", namespace: "shop", uid: null },
  count: 3,
  firstTimestamp: new Date(NOW - 120_000).toISOString(),
  lastTimestamp: new Date(NOW - 60_000).toISOString(),
};

const unreadSlices = () =>
  screen.getByRole("img").querySelectorAll(".border-dashed").length;

describe("a story's words", () => {
  /** A card says what happened in the event's own message, and lists each beside its time. Fails if the token in an address it quotes is printed in either. */
  it("prints an event's message without the credentials in an address", async () => {
    const options: StoryOptions = {
      now: NOW,
      windowMs: HOUR,
      narrowed: false,
      readFrom: null,
    };
    const failed: EventInfo = {
      ...backOff,
      reason: "GitOperationFailed",
      message:
        "failed to clone 'https://git.example.com/acme/infra.git?access_token=s3cr3t-value': 401",
    };
    const [story] = storiesOf([failed], options);
    const { container } = await renderWithRouter(
      <StoryCard
        crd={undefined}
        story={story}
        options={options}
        showNamespace={false}
      />
    );
    expect(container.textContent).toContain("infra.git?access_token=…': 401");
    fireEvent.click(screen.getByRole("button", { name: /Timeline/ }));
    expect(
      screen.getAllByText(/infra\.git\?access_token=…': 401/).length
    ).toBeGreaterThan(1);
    expect(container.textContent).not.toContain("s3cr3t-value");
  });
});

describe("a story card held between watch ticks", () => {
  /**
   * The card skips a redraw when its own events did not change. Fails if a
   * pool cut at the limit moving its oldest row past a slice of the strip
   * leaves that slice drawn as quiet instead of unread.
   */
  it("draws the slices the read stopped short of as unread when only the read's reach moved", async () => {
    const whole: StoryOptions = {
      now: NOW,
      windowMs: HOUR,
      narrowed: false,
      readFrom: null,
    };
    const [story] = storiesOf([backOff], whole);
    const { rerender } = await renderWithRouter(
      <StoryCard
        crd={undefined}
        story={story}
        options={whole}
        showNamespace={false}
      />
    );
    expect(unreadSlices()).toBe(0);

    const cut: StoryOptions = { ...whole, readFrom: NOW - HOUR / 2 };
    rerender(
      <StoryCard
        crd={undefined}
        story={story}
        options={cut}
        showNamespace={false}
      />
    );
    expect(unreadSlices()).toBe(12);
  });

  /**
   * A filter narrowing the feed turns a quiet story from done into cannot
   * say with nothing else on the card moving. Fails if the card is held over
   * a state it no longer has.
   */
  it("draws the story's new state when a filter narrows the feed under it", async () => {
    const started: EventInfo = {
      ...backOff,
      type: "Normal",
      reason: "Started",
      message: "Started container app",
    };
    const whole: StoryOptions = {
      now: NOW,
      windowMs: HOUR,
      narrowed: false,
      readFrom: null,
    };
    const narrowed: StoryOptions = { ...whole, narrowed: true };
    const [done] = storiesOf([started], whole);
    const { rerender } = await renderWithRouter(
      <StoryCard
        crd={undefined}
        story={done}
        options={whole}
        showNamespace={false}
      />
    );
    expect(screen.getByText("done")).toBeInTheDocument();

    const [unsure] = storiesOf([started], narrowed);
    rerender(
      <StoryCard
        crd={undefined}
        story={unsure}
        options={narrowed}
        showNamespace={false}
      />
    );
    expect(screen.getByText("cannot say")).toBeInTheDocument();
  });
});

describe("a story about an earlier object of a name", () => {
  /**
   * A link from the old wd-demo's FailedMount opened the pod made again under
   * the name, as if the warning were its own. Fails if the card links or
   * peeks the name, or stops saying the object was an earlier one.
   */
  it("names the object without a link and says it was an earlier one", async () => {
    const earlier: EventInfo = {
      ...backOff,
      reason: "FailedMount",
      involvedObject: { ...backOff.involvedObject, uid: "d10287fd" },
    };
    const options: StoryOptions = {
      now: NOW,
      windowMs: HOUR,
      narrowed: false,
      readFrom: null,
      past: new Map([["d10287fd", "earlier"]]),
    };
    const [story] = storiesOf([earlier], options);
    const { container } = await renderWithRouter(
      <StoryCard
        crd={undefined}
        story={story}
        options={options}
        showNamespace={false}
      />
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("earlier object")).toBeInTheDocument();
    expect(container.querySelector("[data-past='earlier']")).toHaveAttribute(
      "title",
      expect.stringContaining("earlier Pod named web-0")
    );
  });

  /**
   * Lena's earlier wd-demo card was badged red "still happening" beside its
   * "earlier object" chip. Fails if the card paints a replaced object's story
   * as still going on, or stops saying why it ended.
   */
  it("badges the story as ended with its object, in no alarming colour", async () => {
    const earlier: EventInfo = {
      ...backOff,
      reason: "FailedMount",
      involvedObject: { ...backOff.involvedObject, uid: "d10287fd" },
    };
    const options: StoryOptions = {
      now: NOW,
      windowMs: HOUR,
      narrowed: false,
      readFrom: null,
      past: new Map([["d10287fd", "earlier"]]),
    };
    const [story] = storiesOf([earlier], options);
    await renderWithRouter(
      <StoryCard
        crd={undefined}
        story={story}
        options={options}
        showNamespace={false}
      />
    );
    expect(screen.queryByText("still happening")).toBeNull();
    const badge = screen.getByText("ended with it");
    expect(badge).not.toHaveClass("text-err");
    expect(badge).toHaveAttribute(
      "title",
      expect.stringContaining(
        "The Pod web-0 these events were about was replaced"
      )
    );
  });
});

describe("a story about an object read as deleted", () => {
  /**
   * Lena's HPA, deleted with nothing in its place, read amber "settled".
   * Fails if the card paints a gone object's story as trouble, links or
   * peeks the name, or says it was replaced rather than deleted.
   */
  it("badges the story as ended with its object and marks the name deleted", async () => {
    const options: StoryOptions = {
      now: NOW,
      windowMs: HOUR,
      narrowed: false,
      readFrom: null,
    };
    const old: EventInfo = {
      ...backOff,
      lastTimestamp: new Date(NOW - 20 * 60_000).toISOString(),
    };
    const [settled] = storiesOf([old], options);
    expect(settled.state).toBe("settled");
    const { container } = await renderWithRouter(
      <StoryCard
        crd={undefined}
        story={withGone([settled], new Set([subjectKey(settled.subject)]))[0]}
        options={options}
        showNamespace={false}
      />
    );
    expect(screen.queryByText("settled")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector("[data-past='gone']")).not.toBeNull();
    const badge = screen.getByText("ended with it");
    expect(badge).not.toHaveClass("text-warn");
    expect(badge).toHaveAttribute(
      "title",
      expect.stringContaining("was read as deleted")
    );
  });
});

describe("a story about pods folded by their name", () => {
  /**
   * Lena's card read "поды hello-web" over "Под за 1 минуту": one pod, a
   * title in the plural and a sentence in the singular. Fails if the title
   * and the sentence stop reading the same count of pods.
   */
  it("titles one pod in the singular, as its sentence says it, and several in the plural", async () => {
    const options: StoryOptions = {
      now: NOW,
      windowMs: HOUR,
      narrowed: false,
      readFrom: null,
    };
    const started = (name: string): EventInfo => ({
      ...backOff,
      uid: `${name}.started`,
      type: "Normal",
      reason: "Started",
      message: "Started container app",
      involvedObject: { kind: "Pod", name, namespace: "shop", uid: null },
    });
    const [one] = storiesOf([started("hello-web-5966d9b889-7nvr5")], options);
    const { rerender } = await renderWithRouter(
      <StoryCard
        crd={undefined}
        story={one}
        options={options}
        showNamespace={false}
      />
    );
    expect(screen.getByText("pod of hello-web")).toBeInTheDocument();
    expect(screen.getByText(/^The pod within /)).toBeInTheDocument();

    const [two] = storiesOf(
      [
        started("hello-web-5966d9b889-7nvr5"),
        started("hello-web-5966d9b889-x2k4p"),
      ],
      options
    );
    rerender(
      <StoryCard
        crd={undefined}
        story={two}
        options={options}
        showNamespace={false}
      />
    );
    expect(screen.getByText("pods of hello-web")).toBeInTheDocument();
    expect(screen.getByText(/^Pods within /)).toBeInTheDocument();

    useLocaleStore.setState({ choice: "ru" });
    try {
      rerender(
        <StoryCard
          crd={undefined}
          story={one}
          options={options}
          showNamespace={false}
        />
      );
      expect(await screen.findByText("под из hello-web")).toBeInTheDocument();
      expect(screen.getByText(/^Под за /)).toBeInTheDocument();
    } finally {
      useLocaleStore.setState({ choice: null });
    }
  });
});

describe("a story's clock for a static pod", () => {
  /**
   * The clock places a pod's remembered exits among its events when the pod
   * read is the one the events are about. A static pod's events carry the
   * hash in its mirror annotation. Fails if the pod is matched by its
   * mirror's uid and its exits are left off the clock.
   */
  it("places the exits of a static pod among its events", async () => {
    const client = testQueryClient();
    client.setQueryData(queryKeys.detail("Pod", "kube-system", "etcd-cp"), {
      name: "etcd-cp",
      namespace: "kube-system",
      uid: "9f0c2a11",
      annotations: { "kubernetes.io/config.mirror": "5f3c0d7e" },
      containers: [
        {
          name: "etcd",
          state: { type: "running" },
          lastTerminated: {
            exitCode: 1,
            signal: null,
            reason: "Error",
            message: null,
            startedAt: null,
            finishedAt: new Date(NOW - 90_000).toISOString(),
          },
        },
      ],
    });
    const options: StoryOptions = {
      now: NOW,
      windowMs: HOUR,
      narrowed: false,
      readFrom: null,
    };
    const [story] = storiesOf(
      [
        {
          ...backOff,
          namespace: "kube-system",
          involvedObject: {
            kind: "Pod",
            name: "etcd-cp",
            namespace: "kube-system",
            uid: "5f3c0d7e",
          },
        },
      ],
      options
    );
    await renderWithRouter(
      <StoryCard
        crd={undefined}
        story={story}
        options={options}
        showNamespace={false}
      />,
      { client }
    );
    fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
    expect(
      await screen.findByText("etcd exited with code 1")
    ).toBeInTheDocument();
  });

  /**
   * Seen on a cluster with a Knative-shaped Service beside the core one of
   * its name: both cards were titled "team-a/Service/web". A ClusterIssuer's
   * was titled "default/ClusterIssuer/ca", after where its events are filed.
   * Fails if a namesake's card does not say its group, or a cluster-scoped
   * object's card names a namespace.
   */
  it("titles a namesake with its group and a cluster-scoped object with no namespace", async () => {
    const options: StoryOptions = {
      now: NOW,
      windowMs: HOUR,
      narrowed: false,
      readFrom: null,
    };
    const about = (
      namespace: string,
      involvedObject: EventInfo["involvedObject"]
    ): EventInfo => ({ ...backOff, namespace, involvedObject });
    const stories = storiesOf(
      [
        about("team-a", {
          apiVersion: "v1",
          kind: "Service",
          name: "web",
          namespace: "team-a",
          uid: "a",
        }),
        about("team-a", {
          apiVersion: "serving.knative.dev/v1",
          kind: "Service",
          name: "web",
          namespace: "team-a",
          uid: "b",
        }),
        about("default", {
          apiVersion: "cert-manager.io/v1",
          kind: "ClusterIssuer",
          name: "ca",
          namespace: null,
          uid: "c",
        }),
      ],
      options
    );
    await renderWithRouter(
      <>
        {stories.map((story) => (
          <StoryCard
            key={story.key}
            crd={story.subject.group === "" ? undefined : null}
            story={story}
            options={options}
            showNamespace
          />
        ))}
      </>
    );
    const titles = screen
      .getAllByTestId("resource-ref-name")
      .map((name) => name.textContent);
    expect(titles.sort()).toEqual([
      "ClusterIssuer/ca",
      "team-a/Service.serving.knative.dev/web",
      "team-a/Service/web",
    ]);
  });
});
