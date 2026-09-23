import { useEffect, useRef } from "react";

import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/components/ui/use-toast";
import { commands } from "@/lib/commands";
import {
  listenEvent,
  listenResourceEvents,
  type ResourceEvent,
} from "@/lib/events";
import { notify } from "@/lib/notify";
import {
  Coalescer,
  isOpen,
  judge,
  detailWords,
  LOST_SIGHT_MS,
  outOfTimeVerdict,
  type Says,
  type Verdict,
  type Watch,
} from "@/lib/tell-me-when";
import { useActivityPanelStore } from "@/stores/activityPanelStore";
import { useClusterStore } from "@/stores/clusterStore";
import { useTellMeWhenStore } from "@/stores/tellMeWhenStore";
import { useT, type T } from "@/i18n/useT";
import type { en } from "@/i18n/catalogue";
import type { DrainOutcome } from "@/generated/types";

export interface Answer {
  watch: Watch;
  verdict: Verdict;
}

/** One catalogue line per answer, the object's name filled in. */
export const SAYS_KEY: Record<Says, keyof typeof en.tell> = {
  rolledOut: "saysRolledOut",
  rolloutFailed: "saysRolloutFailed",
  ready: "saysReady",
  crashedAgain: "saysCrashedAgain",
  succeeded: "saysSucceeded",
  failed: "saysFailed",
  drained: "saysDrained",
  drainStopped: "saysDrainStopped",
  drainCancelled: "saysDrainCancelled",
  drainFailed: "saysDrainFailed",
  renewed: "saysRenewed",
  issuanceFailed: "saysIssuanceFailed",
  forwardDied: "saysForwardDied",
  gone: "saysGone",
  lostSight: "saysLostSight",
  timedOut: "saysTimedOut",
};

/**
 * Each drain outcome as its own verdict. Stopped (the node would not empty
 * and needs an opt-in) and Cancelled (the reader stopped it) are explicitly
 * not failures — folding them into `drainFailed` painted an expected ending
 * red, the third state collapsing into the second.
 */
const DRAIN_SAYS: Record<DrainOutcome, Says> = {
  drained: "drained",
  stopped: "drainStopped",
  cancelled: "drainCancelled",
  failed: "drainFailed",
};

export function answerLine(answer: Answer, t: T): string {
  return t("tell", SAYS_KEY[answer.verdict.says], { name: answer.watch.name });
}

/** What a batch of answers says in one notification. */
export function notice(
  answers: Answer[],
  t: T
): { title: string; body: string } {
  const lines = answers.map((a) => answerLine(a, t));
  if (answers.length === 1) {
    return {
      title: lines[0],
      body: detailWords(answers[0].verdict.detail, t) ?? "",
    };
  }
  return {
    title: t("tell", "severalAnswered", { n: answers.length }),
    body: lines.join("\n"),
  };
}

/** Deadlines are two minutes; a check every ten seconds keeps the answer within a breath of it. */
const TIMEOUT_EVERY_MS = 10_000;

/** The timer that says a watch went quiet. */
interface Sight {
  lostTimer: ReturnType<typeof setTimeout> | null;
}

/** The stream behind one open watch. */
interface Stream extends Sight {
  id: string | null;
  off: (() => void) | null;
  closed: boolean;
  /**
   * A list in progress, between `restarted` and `synced`, and whether it
   * held the object. On the stream because the two markers can arrive in
   * different batches.
   */
  relist: { found: boolean } | null;
}

/** Marks the watch answered and queues the answer, unless it was already. */
function settle(
  watchId: string,
  verdict: Verdict,
  coalescer: Coalescer<Answer> | null
) {
  const store = useTellMeWhenStore.getState();
  const current = store.watches.find((w) => w.id === watchId);
  if (!current || !isOpen(current)) return;
  store.setStatus(watchId, { state: "done", verdict, at: Date.now() });
  coalescer?.push({ watch: current, verdict });
}

/**
 * Marks the watch lost, and reports it after `LOST_SIGHT_MS` unless something
 * answers first.
 */
function loseSight(
  watchId: string,
  sight: Sight,
  coalescer: { current: Coalescer<Answer> | null }
) {
  const store = useTellMeWhenStore.getState();
  const watch = store.watches.find((w) => w.id === watchId);
  if (!watch || watch.status.state !== "watching") return;
  const since = Date.now();
  store.setStatus(watchId, { state: "lost", since, told: false });
  if (sight.lostTimer !== null) clearTimeout(sight.lostTimer);
  sight.lostTimer = setTimeout(() => {
    const again = useTellMeWhenStore
      .getState()
      .watches.find((w) => w.id === watchId);
    if (!again || again.status.state !== "lost" || again.status.told) {
      return;
    }
    useTellMeWhenStore
      .getState()
      .setStatus(watchId, { state: "lost", since, told: true });
    coalescer.current?.push({
      watch: again,
      verdict: { says: "lostSight", detail: null },
    });
  }, LOST_SIGHT_MS);
}

/** A lost watch heard from again. */
function regainSight(watchId: string, sight: Sight | undefined) {
  const store = useTellMeWhenStore.getState();
  const watch = store.watches.find((w) => w.id === watchId);
  if (watch?.status.state === "lost") {
    store.setStatus(watchId, { state: "watching" });
  }
  if (sight && sight.lostTimer !== null) clearTimeout(sight.lostTimer);
  if (sight) sight.lostTimer = null;
}

/**
 * Keeps every open "tell me when" on the current cluster looking, and says
 * so when one has an answer. Mounted once, beside the port-forward events.
 */
export function useTellMeWhen() {
  const t = useT();
  const { toast } = useToast();
  const openActivityOn = useActivityPanelStore((s) => s.openOn);
  const context = useClusterStore((s) => s.currentContext);
  const connected = useClusterStore((s) => s.isConnected);
  // The ids alone, so a baseline or status write does not reopen streams.
  const openIds = useTellMeWhenStore((s) =>
    s.watches
      .filter(
        (w) =>
          w.context === context &&
          isOpen(w) &&
          w.kind !== "Node" &&
          w.kind !== "PortForward"
      )
      .map((w) => w.id)
      .join("\n")
  );

  const streams = useRef(new Map<string, Stream>());
  // Drains and forwards have no stream; their answers are events of their own.
  const aside = useRef(new Map<string, Sight>());
  const coalescer = useRef<Coalescer<Answer> | null>(null);
  const deliver = useRef<(answers: Answer[]) => void>(() => {});
  const reopenAll = useRef<() => void>(() => {});

  useEffect(() => {
    deliver.current = (answers) => {
      const { title, body } = notice(answers, t);
      void notify({ title, body });
      toast({
        title,
        description: body || undefined,
        action: (
          <ToastAction
            altText={t("tell", "openWatching")}
            onClick={() => openActivityOn("watching")}
          >
            {t("tell", "openWatching")}
          </ToastAction>
        ),
      });
    };
  }, [t, toast, openActivityOn]);

  useEffect(() => {
    const live = streams.current;
    const pending = new Coalescer<Answer>((answers) =>
      deliver.current(answers)
    );
    coalescer.current = pending;
    return () => {
      for (const stream of live.values()) {
        stream.closed = true;
        stream.off?.();
        if (stream.lostTimer !== null) clearTimeout(stream.lostTimer);
        if (stream.id) {
          void commands.unsubscribeResourceWatch(stream.id).catch(() => {});
        }
      }
      live.clear();
      pending.dispose();
      coalescer.current = null;
    };
  }, []);

  useEffect(() => {
    const live = streams.current;
    const wanted = new Set(openIds.split("\n").filter(Boolean));

    const close = (id: string) => {
      const stream = live.get(id);
      if (!stream) return;
      live.delete(id);
      stream.closed = true;
      stream.off?.();
      if (stream.lostTimer !== null) clearTimeout(stream.lostTimer);
      if (stream.id) {
        void commands.unsubscribeResourceWatch(stream.id).catch(() => {});
      }
    };

    // A lag dropped events nobody can name, so each watch looks again from a
    // fresh list and is lost until that list answers. The lost timer carries
    // over, or a watch already lost would never be reported.
    reopenAll.current = () => {
      for (const watchId of [...live.keys()]) {
        const old = live.get(watchId);
        if (!old) continue;
        const stream: Stream = {
          id: null,
          off: null,
          lostTimer: old.lostTimer,
          closed: false,
          relist: null,
        };
        old.lostTimer = null;
        close(watchId);
        live.set(watchId, stream);
        loseSight(watchId, stream, coalescer);
        void open(watchId, stream);
      }
    };

    for (const id of [...live.keys()]) {
      if (!wanted.has(id) || !connected) close(id);
    }
    if (!connected) return;

    for (const watchId of wanted) {
      if (live.has(watchId)) continue;
      const stream: Stream = {
        id: null,
        off: null,
        lostTimer: null,
        closed: false,
        relist: null,
      };
      live.set(watchId, stream);
      void open(watchId, stream);
    }

    async function open(watchId: string, stream: Stream) {
      const watch = useTellMeWhenStore
        .getState()
        .watches.find((w) => w.id === watchId);
      if (!watch) return;
      try {
        const id = watch.crd
          ? await commands.subscribeCustomObjectWatch(
              watch.crd.group,
              watch.crd.version,
              watch.kind,
              watch.crd.plural,
              watch.namespace,
              watch.name
            )
          : await commands.subscribeObjectWatch(
              watch.kind,
              watch.namespace,
              watch.name
            );
        if (stream.closed) {
          await commands.unsubscribeResourceWatch(id).catch(() => {});
          return;
        }
        stream.id = id;
        stream.off = await listenResourceEvents<unknown>((event) => {
          if (event.payload.stream_id !== id || stream.closed) return;
          onEvent(watchId, stream, event.payload);
        });
        if (stream.closed) {
          stream.off();
          return;
        }
        await commands.resourceWatchSubscribed(id);
      } catch {
        // Never opened: the cluster refused or is unreachable. Reported the
        // way a dropped stream is, so the row says so rather than nothing.
        loseSight(watchId, stream, coalescer);
      }
    }

    function onEvent(
      watchId: string,
      stream: Stream,
      payload: ResourceEvent<unknown>
    ) {
      const store = useTellMeWhenStore.getState();
      const watch = store.watches.find((w) => w.id === watchId);
      if (!watch || !isOpen(watch)) return;

      if (payload.changes.some((c) => c.op === "failed")) {
        loseSight(watchId, stream, coalescer);
        return;
      }
      // A `restarted` marker is the watcher trying again, not the cluster
      // answering: kube sends one before every retry of a refused list.
      const answered = payload.changes.some((c) => c.op !== "restarted");
      if (watch.status.state === "lost" && answered) {
        regainSight(watchId, stream);
      }
      let current = store.watches.find((w) => w.id === watchId) ?? watch;
      for (const change of payload.changes) {
        if (change.op === "restarted") {
          stream.relist = { found: false };
          continue;
        }
        // The list is selected by name, so one that finished without the
        // object is the cluster saying it is not there. kube sends no
        // `deleted` for it, and a lag may have dropped the one it did send.
        const emptied =
          change.op === "synced" && stream.relist?.found === false;
        if (change.op === "synced") stream.relist = null;
        if (change.op === "applied" && stream.relist)
          stream.relist.found = true;
        const op = emptied ? "deleted" : change.op;
        if (op !== "applied" && op !== "deleted") continue;
        const { verdict, baseline } = judge(
          current,
          op,
          emptied ? null : change.resource
        );
        if (verdict) {
          settle(watchId, verdict, coalescer.current);
          close(watchId);
          return;
        }
        if (baseline !== current.baseline) {
          store.setBaseline(watchId, baseline);
          current = { ...current, baseline };
        }
      }
    }

    // No cleanup here on purpose: this effect re-runs on every list change,
    // and the streams it did not touch have to outlive the run.
  }, [openIds, connected]);

  useEffect(() => {
    const kept = aside.current;
    const sightOf = (watchId: string) => {
      let sight = kept.get(watchId);
      if (!sight) {
        sight = { lostTimer: null };
        kept.set(watchId, sight);
      }
      return sight;
    };
    // The drain's ending and the forward's death travel the same bridge, so
    // a lag can drop them too. A forward can be asked again; a drain cannot,
    // and is lost until its next progress report says it is still going.
    const off = listenEvent("event-bridge-lagged", () => {
      reopenAll.current();
      const open = useTellMeWhenStore.getState().watches.filter(isOpen);
      for (const watch of open) {
        if (watch.kind === "Node")
          loseSight(watch.id, sightOf(watch.id), coalescer);
      }
      const forwards = open.filter((w) => w.kind === "PortForward");
      if (forwards.length === 0) return;
      commands.listPortForwards().then(
        (sessions) => {
          const alive = new Set(sessions.map((s) => s.id));
          for (const watch of forwards) {
            if (watch.sessionId && alive.has(watch.sessionId)) continue;
            settle(
              watch.id,
              { says: "forwardDied", detail: null },
              coalescer.current
            );
          }
        },
        () => {
          for (const watch of forwards) {
            loseSight(watch.id, sightOf(watch.id), coalescer);
          }
        }
      );
    });
    return () => {
      void off.then((stop) => stop());
      for (const sight of kept.values()) {
        if (sight.lostTimer !== null) clearTimeout(sight.lostTimer);
      }
      kept.clear();
    };
  }, []);

  useEffect(() => {
    let offDrain: null | (() => void) = null;
    let offProgress: null | (() => void) = null;
    let offForward: null | (() => void) = null;
    void listenEvent("drain-progress", (event) => {
      const watch = useTellMeWhenStore
        .getState()
        .watches.find(
          (w) => w.kind === "Node" && w.name === event.payload.node && isOpen(w)
        );
      if (watch) regainSight(watch.id, aside.current.get(watch.id));
    }).then((off) => {
      offProgress = off;
    });
    void listenEvent("drain-finished", (event) => {
      const { node, outcome, message } = event.payload;
      // No current-context filter: the payload carries no context and the
      // drain keeps running across a cluster switch, so match by identity
      // the way the port-forward handler below does. Filtering by the shown
      // context silently dropped the answer after a switch — the one thing
      // this feature exists to prevent.
      const watch = useTellMeWhenStore
        .getState()
        .watches.find((w) => w.kind === "Node" && w.name === node && isOpen(w));
      if (!watch) return;
      settle(
        watch.id,
        {
          says: DRAIN_SAYS[outcome],
          detail: outcome === "drained" ? null : (message ?? null),
        },
        coalescer.current
      );
    }).then((off) => {
      offDrain = off;
    });
    void listenEvent("port-forward-status", (event) => {
      const { id, status, message } = event.payload;
      const watch = useTellMeWhenStore
        .getState()
        .watches.find(
          (w) => w.kind === "PortForward" && w.sessionId === id && isOpen(w)
        );
      if (!watch) return;
      if (status !== "stopped" && status !== "error") {
        regainSight(watch.id, aside.current.get(watch.id));
        return;
      }
      settle(
        watch.id,
        { says: "forwardDied", detail: message ?? null },
        coalescer.current
      );
    }).then((off) => {
      offForward = off;
    });
    return () => {
      offDrain?.();
      offProgress?.();
      offForward?.();
    };
    // No context in the body any more: these listeners resolve the watch by
    // identity, so they register once and survive a cluster switch.
  }, []);

  useEffect(() => {
    const tick = setInterval(() => {
      const now = Date.now();
      const store = useTellMeWhenStore.getState();
      store.expire(now);
      for (const watch of store.timeOut(now)) {
        // Already told it lost sight: the deadline has nothing to add.
        if (watch.status.state === "lost" && watch.status.told) continue;
        coalescer.current?.push({ watch, verdict: outOfTimeVerdict(watch) });
      }
    }, TIMEOUT_EVERY_MS);
    return () => clearInterval(tick);
  }, []);
}
