import { describe, expect, it } from "vite-plus/test";

import type { EventInfo } from "@/generated/types";
import { translate } from "@/i18n";
import { sayWords } from "@/i18n/say";
import type { T } from "@/i18n/useT";
import corpus from "./__fixtures__/live-events.json";
import {
  rolloutsAndScales,
  activityOf,
  densityOf,
  familyOf,
  RECENT_MS,
  sortStories,
  storiesOf,
  timelineOf,
  WINDOW_MS,
  withStatusMarks,
  type Story,
} from "./event-stories";

const NOW = Date.parse("2026-09-07T08:00:00Z");
const HOUR = WINDOW_MS["1h"];

let uids = 0;

function event(
  over: Partial<EventInfo> & { kind: string; name: string }
): EventInfo {
  const { kind, name, ...rest } = over;
  const last = rest.lastTimestamp ?? new Date(NOW - 60_000).toISOString();
  return {
    name: `ev-${++uids}`,
    namespace: "shop",
    uid: `uid-${uids}`,
    type: "Normal",
    reason: "Started",
    message: "Started container app",
    source: "kubelet",
    involvedObject: { kind, name, namespace: "shop", uid: null },
    count: 1,
    firstTimestamp: last,
    lastTimestamp: last,
    ...rest,
  };
}

const ago = (ms: number) => new Date(NOW - ms).toISOString();

function one(stories: Story[], name: string): Story {
  const found = stories.find((s) => s.subject.name === name);
  if (!found) throw new Error(`no story about ${name}`);
  return found;
}

describe("the recorded hour", () => {
  const events = corpus as EventInfo[];
  const now =
    Math.max(...events.map((e) => Date.parse(e.lastTimestamp ?? ""))) + 1000;
  const stories = sortStories(
    storiesOf(events, { now, windowMs: HOUR, narrowed: false }),
    "warningsFirst"
  );

  /**
   * The corpus is what a k3d cluster wrote in one hour: 860 events over 157
   * objects. Every number here is what the builder must keep making of it;
   * a change in grouping shows up as a change in the count.
   */
  it("folds 860 events into 107 stories, warnings first", () => {
    expect(events).toHaveLength(860);
    expect(stories).toHaveLength(107);
    expect(stories[0].state).toBe("stillHappening");
    expect(stories.at(-1)?.state).toBe("done");
    const states = stories.map((s) => s.state);
    expect(states.indexOf("done")).toBeGreaterThan(
      states.lastIndexOf("settled")
    );
  });

  /** The Deployment said which ReplicaSet, the ReplicaSet said which pod: three objects, one story, nothing guessed. */
  it("hangs a rollout on its Deployment through the controllers' own words", () => {
    const rollout = one(stories, "shop-db-pooler-rw");
    expect(rollout.subject).toEqual({
      kind: "Deployment",
      name: "shop-db-pooler-rw",
      namespace: "cnpg-demo",
      byName: false,
    });
    expect(rollout.members).toHaveLength(3);
    expect(rollout.activity).toBe("rollout");
    expect(rollout.says).toEqual({
      key: "storyChanged",
      values: {
        spanMs: 5000,
        scheduled: 1,
        pulled: 2,
        started: 2,
        stopped: 0,
        changes: { key: "changesRollouts", values: { n: 1 } },
      },
    });
  });

  /** No controller event names these pods in the hour, so the fold is by name and says so. */
  it("folds orphaned pods by their generated suffix and admits it", () => {
    const pulls = one(stories, "log-demo");
    expect(pulls.subject).toEqual({
      kind: null,
      name: "log-demo",
      namespace: "k8s-gui-test",
      byName: true,
    });
    expect([...pulls.members].sort()).toEqual([
      "Pod/log-demo-596db7455d-cstqv",
      "Pod/log-demo-596db7455d-q6858",
    ]);
  });

  /**
   * These pods could not be scheduled, then could not be pulled. The story
   * is about the later trouble, counts only that trouble, quotes the span of
   * *that* trouble rather than the group's, and gives the kubelet's full
   * sentence rather than its bare "Error: ErrImagePull".
   */
  it("tells the latest trouble with that trouble's own count and words", () => {
    const pulls = one(stories, "log-demo");
    expect(pulls.activity).toBe("pull");
    expect(pulls.warnings).toBe(52);
    expect(pulls.says).toEqual({
      key: "storyPull",
      values: {
        // The count is its own sentence: Russian needs three forms where
        // English needs two, so the outer string cannot carry `{n} times`.
        times: { key: "timesSeen", values: { n: 12 } },
        // The pulls all failed at 07:29:42. The 99 minutes this used to
        // quote belonged to the scheduling failures in the same story —
        // a span borrowed from trouble the sentence is not counting.
        spanMs: 0,
        detail: 'Failed to pull image "busybox:1.36": pull QPS exceeded',
      },
    });
    expect(pulls.reasons.filter((r) => r.warning).map((r) => r.reason)).toEqual(
      ["FailedScheduling", "Failed"]
    );
  });

  it("keeps a warning younger than five minutes as still happening", () => {
    const hpa = one(stories, "hpa-blind");
    expect(hpa.subject.kind).toBe("HorizontalPodAutoscaler");
    expect(hpa.state).toBe("stillHappening");
    expect(hpa.says.key).toBe("storyScaling");
    expect(hpa.says.values?.times).toEqual({
      key: "timesSeen",
      values: { n: 570 },
    });
    const node = one(stories, "k3d-k8s-gui-dev-server-0");
    expect(node.state).toBe("settled");
    expect(node.activity).toBe("pressure");
  });

  it("reads a finished job as one created and one completed", () => {
    expect(one(stories, "cron-demo-29812785").says).toEqual({
      key: "storyJob",
      values: {
        spanMs: 3000,
        created: { key: "jobsCreated", values: { n: 1 } },
        completed: 1,
      },
    });
  });

  /** A reason the table does not know still gets a story, worded from its own count and message. */
  it("gives an unknown reason a sentence made only of what it wrote", () => {
    const address = one(stories, "10.43.34.152");
    expect(address.activity).toBe("other");
    expect(address.says.key).toBe("storyTrouble");
    expect(address.says.values?.reason).toBe("IPAddressWrongReference");
  });
});

describe("familyOf", () => {
  it("strips the pod suffix and a template hash, and nothing else", () => {
    expect(familyOf("payments-7b6d9c5f4-x8k2p")).toBe("payments");
    expect(familyOf("daemon-demo-kn8jg")).toBe("daemon-demo");
    expect(familyOf("cron-demo-29812740-mlvsb")).toBe("cron-demo-29812740");
    expect(familyOf("web-0")).toBe("web-0");
    expect(familyOf("helper-pod-create-pvc-fc36fc87-c698")).toBe(
      "helper-pod-create-pvc-fc36fc87-c698"
    );
  });
});

describe("placing events", () => {
  /** Would put the guess back: a pod named like a Deployment's is not that Deployment's until a controller says so. */
  it("marks a story by name when any member was folded without evidence", () => {
    const stories = storiesOf(
      [
        event({
          kind: "Deployment",
          name: "payments",
          reason: "ScalingReplicaSet",
          message: "Scaled up replica set payments-7b6d9c5f4 from 0 to 1",
        }),
        event({ kind: "Pod", name: "payments-7b6d9c5f4-x8k2p" }),
      ],
      { now: NOW, windowMs: HOUR, narrowed: false }
    );
    expect(stories).toHaveLength(1);
    expect(stories[0].subject).toEqual({
      kind: "Deployment",
      name: "payments",
      namespace: "shop",
      byName: true,
    });
  });

  it("follows Deployment to ReplicaSet to Pod when every link was written", () => {
    const stories = storiesOf(
      [
        event({
          kind: "Deployment",
          name: "payments",
          reason: "ScalingReplicaSet",
          message: "Scaled up replica set payments-7b6d9c5f4 from 0 to 1",
        }),
        event({
          kind: "ReplicaSet",
          name: "payments-7b6d9c5f4",
          reason: "SuccessfulCreate",
          message: "Created pod: payments-7b6d9c5f4-x8k2p",
        }),
        event({ kind: "Pod", name: "payments-7b6d9c5f4-x8k2p" }),
      ],
      { now: NOW, windowMs: HOUR, narrowed: false }
    );
    expect(stories).toHaveLength(1);
    expect(stories[0].subject.byName).toBe(false);
    expect(stories[0].members).toHaveLength(3);
  });

  it("keeps a pod with no generated suffix as its own story", () => {
    const stories = storiesOf([event({ kind: "Pod", name: "web-0" })], {
      now: NOW,
      windowMs: HOUR,
      narrowed: false,
    });
    expect(stories[0].subject).toEqual({
      kind: "Pod",
      name: "web-0",
      namespace: "shop",
      byName: false,
    });
  });

  it("does not merge a Node with pods that happen to share its name", () => {
    const stories = storiesOf(
      [
        event({ kind: "Node", name: "worker", reason: "NodeReady" }),
        event({ kind: "Pod", name: "worker-abcde" }),
      ],
      { now: NOW, windowMs: HOUR, narrowed: false }
    );
    expect(stories).toHaveLength(2);
  });
});

describe("the window", () => {
  it("leaves out what was last seen before it and keeps what has no date", () => {
    const stories = storiesOf(
      [
        event({ kind: "Pod", name: "old", lastTimestamp: ago(2 * HOUR) }),
        event({ kind: "Pod", name: "fresh", lastTimestamp: ago(HOUR / 2) }),
        event({
          kind: "Pod",
          name: "undated",
          lastTimestamp: null,
          firstTimestamp: null,
        }),
      ],
      { now: NOW, windowMs: HOUR, narrowed: false }
    );
    expect(stories.map((s) => s.subject.name).sort()).toEqual([
      "fresh",
      "undated",
    ]);
    expect(one(stories, "undated").lastAt).toBeNull();
  });
});

describe("state", () => {
  const warning = (name: string, lastTimestamp: string) =>
    event({
      kind: "Pod",
      name,
      type: "Warning",
      reason: "BackOff",
      message: "Back-off restarting failed container",
      lastTimestamp,
    });

  /** Deleting the recency branch would call every warning settled or every warning live. */
  it("is still happening within five minutes and settled after", () => {
    const stories = storiesOf(
      [
        warning("live", ago(RECENT_MS - 1000)),
        warning("quiet", ago(RECENT_MS + 1000)),
        event({ kind: "Pod", name: "calm" }),
      ],
      { now: NOW, windowMs: HOUR, narrowed: false }
    );
    expect(one(stories, "live").state).toBe("stillHappening");
    expect(one(stories, "quiet").state).toBe("settled");
    expect(one(stories, "calm").state).toBe("done");
  });

  it("orders warnings first by state, then by how many, then newest", () => {
    const stories = storiesOf(
      [
        event({ kind: "Pod", name: "calm", lastTimestamp: ago(1000) }),
        warning("quiet", ago(RECENT_MS + 1000)),
        warning("live", ago(1000)),
      ],
      { now: NOW, windowMs: HOUR, narrowed: false }
    );
    expect(
      sortStories(stories, "warningsFirst").map((s) => s.subject.name)
    ).toEqual(["live", "quiet", "calm"]);
    expect(sortStories(stories, "newest").map((s) => s.subject.name)).toEqual([
      "calm",
      "live",
      "quiet",
    ]);
  });
});

describe("activityOf", () => {
  it("reads BackOff and Failed by their message, and lifecycle by the subject", () => {
    const pod = (reason: string, message: string) =>
      event({ kind: "Pod", name: "p", reason, message });
    expect(activityOf(pod("BackOff", "Back-off pulling image x"), null)).toBe(
      "pull"
    );
    expect(
      activityOf(pod("BackOff", "Back-off restarting failed container"), null)
    ).toBe("crash");
    expect(activityOf(pod("Failed", 'Failed to pull image "x"'), null)).toBe(
      "pull"
    );
    expect(
      activityOf(pod("Failed", "Error: failed to create containerd task"), null)
    ).toBe("crash");
    expect(activityOf(pod("Started", "Started container"), "CronJob")).toBe(
      "job"
    );
    expect(activityOf(pod("Started", "Started container"), "Deployment")).toBe(
      "rollout"
    );
    expect(activityOf(pod("SomethingNew", ""), null)).toBe("other");
  });
});

describe("the timeline", () => {
  const story = storiesOf(
    [
      event({
        kind: "Pod",
        name: "p",
        reason: "BackOff",
        type: "Warning",
        message: "Back-off restarting failed container",
        count: 9,
        firstTimestamp: ago(30 * 60_000),
        lastTimestamp: ago(60_000),
      }),
      event({
        kind: "Pod",
        name: "p",
        reason: "Started",
        lastTimestamp: ago(31 * 60_000),
      }),
    ],
    { now: NOW, windowMs: HOUR, narrowed: false }
  )[0];

  it("lays folded repeats out by first seen with their count and span", () => {
    const entries = timelineOf(story);
    expect(entries.map((e) => e.reason)).toEqual(["Started", "BackOff"]);
    expect(entries[1].count).toBe(9);
    expect(entries[1].until).toBe(NOW - 60_000);
  });

  /** A pod's remembered exit sits between the events at its own time and is labelled as not one of them. */
  it("puts a container exit on the same clock, marked as status", () => {
    const entries = withStatusMarks(timelineOf(story), [
      {
        at: NOW - 30 * 60_000 - 5000,
        container: "app",
        exitCode: 1,
        reason: "Error",
        pod: "p",
      },
    ]);
    expect(entries.map((e) => [e.reason, e.fromStatus])).toEqual([
      ["Started", false],
      ["Error", true],
      ["BackOff", false],
    ]);
  });

  it("marks density by when each event was last seen, warnings on top", () => {
    const buckets = densityOf(
      story,
      { now: NOW, windowMs: HOUR, narrowed: false },
      6
    );
    expect(buckets.map((b) => b.count)).toEqual([0, 0, 1, 0, 0, 1]);
    expect(buckets[5].worst).toBe("warn");
    expect(buckets[2].worst).toBeNull();
  });
});

describe("counts a reader's language can say", () => {
  /**
   * `{n} times` in the sentence itself renders "1 times" in English and
   * "2 раз" in Russian, and no scanner finds it: the whole string is there,
   * it is only the count inside it that is wrong. The count is its own
   * catalogue plural, resolved before the sentence holds it.
   */
  it("says a single occurrence without the plural noun", () => {
    const once = storiesOf(
      [
        event({
          reason: "FailedScheduling",
          type: "Warning",
          message: "0/3 nodes are available: insufficient cpu",
          count: 1,
          kind: "Pod",
          name: "web-0",
          lastTimestamp: new Date(NOW - 1000).toISOString(),
        }),
      ],
      { now: NOW, windowMs: HOUR, narrowed: false }
    );
    const en: T = (section, key, values) =>
      translate("en", section, key, values);
    const said = sayWords(once[0].says, en);
    expect(said).toContain("once");
    expect(said).not.toContain("1 times");
  });

  /** Russian's second form: 2, 3 and 4 take "раза", not "раз". */
  it("takes the Russian case for two, three and four", () => {
    const ru: T = (section, key, values) =>
      translate("ru", section, key, values);
    for (const n of [2, 3, 4]) {
      expect(sayWords({ key: "timesSeen", values: { n } }, ru)).toBe(
        `${n} раза`
      );
    }
    expect(sayWords({ key: "timesSeen", values: { n: 1 } }, ru)).toBe("1 раз");
    expect(sayWords({ key: "timesSeen", values: { n: 11 } }, ru)).toBe(
      "11 раз"
    );
  });

  /** The sentence asked for `{n}` while the story passed `times`, so "×{n}" reached the Events page. */
  it("fills every slot of an unknown reason's sentence, with the minute in the case its preposition asks for", () => {
    const [story] = storiesOf(
      [
        event({
          reason: "FailedCreatePodSandBox",
          type: "Warning",
          message: "Failed to create pod sandbox",
          count: 3,
          kind: "Pod",
          name: "web-0",
          firstTimestamp: ago(90_000),
          lastTimestamp: ago(1000),
        }),
      ],
      { now: NOW, windowMs: HOUR, narrowed: false }
    );
    const en: T = (section, key, values) =>
      translate("en", section, key, values);
    const ru: T = (section, key, values) =>
      translate("ru", section, key, values);
    expect(story.says.key).toBe("storyTrouble");
    expect(sayWords(story.says, en)).toBe(
      "FailedCreatePodSandBox 3 times within 1 minute: Failed to create pod sandbox"
    );
    expect(sayWords(story.says, ru)).toBe(
      "FailedCreatePodSandBox 3 раза за 1 минуту: Failed to create pod sandbox"
    );
  });
});

describe("which names are siblings", () => {
  /**
   * The suffix alphabet holds seven of the ten digits, so a CronJob's minute
   * segment falls inside it whenever the clock avoids 0, 1 and 3 — and the
   * same CronJob then folds two ways depending on the minute it ran.
   */
  it("keeps a run's pods on their run, whatever the clock said", () => {
    // 29845672 is all-digit and entirely inside the suffix alphabet.
    expect(familyOf("cron-demo-29845672-mlvsb")).toBe("cron-demo-29845672");
    // 29812785 carries a 1 and a 3, which are not.
    expect(familyOf("cron-demo-29812785-mlvsb")).toBe("cron-demo-29812785");
  });

  /** A Deployment's pods still fold through the ReplicaSet's template hash. */
  it("still folds a deployment's pods together", () => {
    expect(familyOf("web-7b6d9c5f4-x8k2p")).toBe("web");
    expect(familyOf("web-7b6d9c5f4-zzzzz")).toBe("web");
  });

  /** A StatefulSet's ordinal is not a generated suffix. */
  it("leaves a name that carries no generated suffix alone", () => {
    expect(familyOf("web-0")).toBe("web-0");
    expect(familyOf("web-11")).toBe("web-11");
  });
});

describe("what the kubelet said, not what the app assumed", () => {
  /**
   * A Pod `Failed` without "image" in it is a crash for ranking, but only a
   * `BackOff` is the kubelet backing off from a restart. A missing secret
   * never reached a container at all, and the kubelet's own sentence is the
   * only thing on the card that says which it was.
   */
  it("does not claim a restart backoff for a container that never started", () => {
    const [story] = storiesOf(
      [
        event({
          reason: "Failed",
          type: "Warning",
          message: 'Error: secret "db-creds" not found',
          count: 5,
          kind: "Pod",
          name: "api-7b6d9c5f4-x8k2p",
        }),
      ],
      { now: NOW, windowMs: HOUR, narrowed: false }
    );
    expect(story.activity).toBe("crash");
    expect(story.says.key).toBe("storyStartFailed");
    expect(story.says.values?.detail).toBe(
      'Error: secret "db-creds" not found'
    );
  });

  it("keeps the backoff wording where the kubelet really said BackOff", () => {
    const [story] = storiesOf(
      [
        event({
          reason: "BackOff",
          type: "Warning",
          message: "Back-off restarting failed container",
          count: 9,
          kind: "Pod",
          name: "api-7b6d9c5f4-x8k2p",
        }),
      ],
      { now: NOW, windowMs: HOUR, narrowed: false }
    );
    expect(story.says.key).toBe("storyCrash");
    expect(story.says.values?.detail).toBe(
      "Back-off restarting failed container"
    );
  });
});

describe("the density strip", () => {
  /**
   * A pool cut at the limit never reached the older end of the window. Those
   * slices were drawn as the flat hairline a quiet slice gets, so "nobody
   * looked" and "nothing happened" were the same picture.
   */
  it("tells a slice nobody read from a slice where nothing happened", () => {
    const story = one(
      storiesOf(
        [
          event({
            reason: "BackOff",
            type: "Warning",
            kind: "Pod",
            name: "web-7b6d9c5f4-x8k2p",
            lastTimestamp: new Date(NOW - 60_000).toISOString(),
          }),
        ],
        { now: NOW, windowMs: HOUR, narrowed: false }
      ),
      "web"
    );
    const whole = densityOf(story, {
      now: NOW,
      windowMs: HOUR,
      narrowed: false,
    });
    expect(whole.every((bucket) => bucket.read)).toBe(true);

    // The read only reached the last ten minutes of the hour.
    const cut = densityOf(
      story,
      {
        now: NOW,
        windowMs: HOUR,
        narrowed: false,
        readFrom: NOW - 10 * 60_000,
      },
      6
    );
    expect(cut.map((bucket) => bucket.read)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });
});

describe("what a Deployment's story says it did", () => {
  const MIN = 60_000;
  const scaled = (
    message: string,
    minutesAgo: number,
    count = 1,
    lastAgo = minutesAgo
  ) =>
    event({
      kind: "Deployment",
      name: "hello-web",
      reason: "ScalingReplicaSet",
      message,
      source: "deployment-controller",
      count,
      firstTimestamp: ago(minutesAgo * MIN),
      lastTimestamp: ago(lastAgo * MIN),
    });
  const ru: T = (section, key, values) => translate("ru", section, key, values);
  const en: T = (section, key, values) => translate("en", section, key, values);

  /** lena-sandbox/hello-web as Lena read it: created, restarted twice, scaled 1 to 2 and back twice. */
  const lena = [
    scaled("Scaled up replica set hello-web-5bc6cfc846 from 0 to 1", 25),
    scaled("Scaled up replica set hello-web-584d68fccc from 0 to 1", 20),
    scaled("Scaled down replica set hello-web-5bc6cfc846 from 1 to 0", 20),
    scaled(
      "Scaled up replica set hello-web-584d68fccc from 1 to 2",
      13,
      2,
      2.5
    ),
    scaled("Scaled down replica set hello-web-584d68fccc from 2 to 1", 3, 2, 2),
    scaled("Scaled up replica set hello-web-8fbb949d9 from 0 to 1", 1.5),
    scaled("Scaled down replica set hello-web-584d68fccc from 1 to 0", 1.5),
  ];

  /**
   * Lena's story read "Развёрнуто за 25 минут" over three rollouts and four
   * scales, ScalingReplicaSet x9. Fails if the sentence calls them one
   * rollout, or counts a scale as a rollout or the other way round.
   */
  it("counts three rollouts and four scales where Lena's story said one rollout", () => {
    expect(rolloutsAndScales(lena)).toEqual({ rollouts: 3, scales: 4 });
    const [story] = storiesOf(lena, {
      now: NOW,
      windowMs: HOUR,
      narrowed: false,
    });
    expect(sayWords(story.says, en)).toMatch(
      /^3 rollouts and 4 scales within /
    );
    expect(sayWords(story.says, ru)).toMatch(
      /^3 развёртывания и 4 масштабирования за /
    );
  });

  /**
   * Lena's hello-web in round 8: created, then scaled to zero and back twice,
   * one ReplicaSet throughout. The controller folds the three rises into one
   * event counted 3, and the story said "3 rollouts and 2 scales". Fails if
   * a repeat of the same ReplicaSet back from zero is called a rollout.
   */
  it("counts a ReplicaSet raised from zero again as a scale, not another rollout", () => {
    const events = [
      scaled(
        "Scaled up replica set hello-web-5bc6cfc846 from 0 to 1",
        17,
        3,
        2
      ),
      scaled(
        "Scaled down replica set hello-web-5bc6cfc846 from 1 to 0",
        12,
        2,
        4
      ),
    ];
    expect(rolloutsAndScales(events)).toEqual({ rollouts: 1, scales: 4 });
  });

  /** A rollback raises the old ReplicaSet again past the new one: each rise there is a rollout. */
  it("still counts a ReplicaSet raised again after another rose between as a rollout", () => {
    const events = [
      scaled("Scaled up replica set web-a from 0 to 1", 30, 2, 5),
      scaled("Scaled up replica set web-b from 0 to 1", 20),
      scaled("Scaled down replica set web-a from 1 to 0", 20, 2, 5),
      scaled("Scaled down replica set web-b from 1 to 0", 5),
    ];
    expect(rolloutsAndScales(events).rollouts).toBe(3);
  });

  /** A rolling restart of three replicas steps both ReplicaSets six times. Fails if a step of it is counted as a scale. */
  it("reads every step of a three-replica rolling restart as one rollout", () => {
    const steps = [
      ["up", "new-7c9d8", 0, 1],
      ["down", "old-5f6b7", 3, 2],
      ["up", "new-7c9d8", 1, 2],
      ["down", "old-5f6b7", 2, 1],
      ["up", "new-7c9d8", 2, 3],
      ["down", "old-5f6b7", 1, 0],
    ] as const;
    const events = steps.map(([way, rs, from, to], i) =>
      scaled(
        `Scaled ${way} replica set ${rs} from ${from} to ${to}`,
        10 - i / 3
      )
    );
    expect(rolloutsAndScales(events)).toEqual({ rollouts: 1, scales: 0 });
  });

  /**
   * With maxSurge 0 the old ReplicaSet empties a second before the new one
   * rises, in the older wording with the count first. Fails if that drain
   * reads as a scale to zero, or holds every later scale inside the rollout.
   */
  it("reads an old ReplicaSet emptied just before the new one rises as the same rollout", () => {
    const events = [
      scaled("Scaled down replica set hello-web-5bc6cfc846 to 0 from 1", 10),
      scaled(
        "Scaled up replica set hello-web-584d68fccc to 1 from 0",
        10 - 1 / 60
      ),
      scaled("Scaled up replica set hello-web-584d68fccc to 2 from 1", 5),
    ];
    expect(rolloutsAndScales(events)).toEqual({ rollouts: 1, scales: 1 });
  });

  /** A pod nothing scaled is not a rollout. Fails if its story claims one. */
  it("tells a pod's own start without calling it a rollout", () => {
    const [story] = storiesOf(
      ["Scheduled", "Pulled", "Created", "Started"].map((reason) =>
        event({ kind: "Pod", name: "shell-demo", reason })
      ),
      { now: NOW, windowMs: HOUR, narrowed: false }
    );
    expect(story.says.key).toBe("storyPods");
    expect(sayWords(story.says, en)).toMatch(/^Pods within /);
  });
});
