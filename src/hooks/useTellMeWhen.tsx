import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/components/ui/use-toast";
import { commands } from "@/lib/commands";
import { notify } from "@/lib/notify";
import {
  Coalescer,
  isOpen,
  judge,
  LOST_SIGHT_MS,
  type Says,
  type Verdict,
  type Watch,
} from "@/lib/tell-me-when";
import { useActivityPanelStore } from "@/stores/activityPanelStore";
import { useClusterStore } from "@/stores/clusterStore";
import { useTellMeWhenStore } from "@/stores/tellMeWhenStore";
import { useT, type T } from "@/i18n/useT";
import type { en } from "@/i18n/catalogue";

interface WatchChange {
  op: "applied" | "deleted" | "restarted" | "synced" | "failed";
  resource: unknown;
}

interface ResourceEventPayload {
  stream_id: string;
  changes: WatchChange[];
  error: string | null;
}

interface DrainFinished {
  node: string;
  outcome: "drained" | "stopped" | "cancelled" | "failed";
  message: string | null;
}

interface ForwardStatus {
  id: string;
  status: string;
  message?: string | null;
}

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
  drainFailed: "saysDrainFailed",
  renewed: "saysRenewed",
  issuanceFailed: "saysIssuanceFailed",
  forwardDied: "saysForwardDied",
  gone: "saysGone",
  lostSight: "saysLostSight",
  timedOut: "saysTimedOut",
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
    return { title: lines[0], body: answers[0].verdict.detail ?? "" };
  }
  return {
    title: t("tell", "severalAnswered", { count: answers.length }),
    body: lines.join("\n"),
  };
}

/** Deadlines are two minutes; a check every ten seconds keeps the answer within a breath of it. */
const TIMEOUT_EVERY_MS = 10_000;

/** The stream behind one open watch, and the timer that says it went quiet. */
interface Stream {
  id: string | null;
  off: (() => void) | null;
  lostTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
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
  const coalescer = useRef<Coalescer<Answer> | null>(null);
  const deliver = useRef<(answers: Answer[]) => void>(() => {});

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
        stream.off = await listen<ResourceEventPayload>(
          "resource-event",
          (event) => {
            if (event.payload.stream_id !== id || stream.closed) return;
            onEvent(watchId, stream, event.payload);
          }
        );
        if (stream.closed) {
          stream.off();
          return;
        }
        await commands.resourceWatchSubscribed(id);
      } catch {
        // Never opened: the cluster refused or is unreachable. Reported the
        // way a dropped stream is, so the row says so rather than nothing.
        lost(watchId, stream);
      }
    }

    function onEvent(
      watchId: string,
      stream: Stream,
      payload: ResourceEventPayload
    ) {
      const store = useTellMeWhenStore.getState();
      const watch = store.watches.find((w) => w.id === watchId);
      if (!watch || !isOpen(watch)) return;

      if (payload.changes.some((c) => c.op === "failed")) {
        lost(watchId, stream);
        return;
      }
      if (watch.status.state === "lost") {
        store.setStatus(watchId, { state: "watching" });
        if (stream.lostTimer !== null) clearTimeout(stream.lostTimer);
        stream.lostTimer = null;
      }
      let current = store.watches.find((w) => w.id === watchId) ?? watch;
      for (const change of payload.changes) {
        if (change.op !== "applied" && change.op !== "deleted") continue;
        const { verdict, baseline } = judge(
          current,
          change.op,
          change.resource
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

    function lost(watchId: string, stream: Stream) {
      const store = useTellMeWhenStore.getState();
      const watch = store.watches.find((w) => w.id === watchId);
      if (!watch || watch.status.state !== "watching") return;
      const since = Date.now();
      store.setStatus(watchId, { state: "lost", since, told: false });
      if (stream.lostTimer !== null) clearTimeout(stream.lostTimer);
      stream.lostTimer = setTimeout(() => {
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
    // No cleanup here on purpose: this effect re-runs on every list change,
    // and the streams it did not touch have to outlive the run.
  }, [openIds, connected]);

  useEffect(() => {
    let offDrain: null | (() => void) = null;
    let offForward: null | (() => void) = null;
    void listen<DrainFinished>("drain-finished", (event) => {
      const { node, outcome, message } = event.payload;
      const watch = useTellMeWhenStore
        .getState()
        .watches.find(
          (w) =>
            w.context === context &&
            w.kind === "Node" &&
            w.name === node &&
            isOpen(w)
        );
      if (!watch) return;
      settle(
        watch.id,
        outcome === "drained"
          ? { says: "drained", detail: null }
          : { says: "drainFailed", detail: message ?? outcome },
        coalescer.current
      );
    }).then((off) => {
      offDrain = off;
    });
    void listen<ForwardStatus>("port-forward-status", (event) => {
      const { id, status, message } = event.payload;
      if (status !== "stopped" && status !== "error") return;
      const watch = useTellMeWhenStore
        .getState()
        .watches.find(
          (w) => w.kind === "PortForward" && w.sessionId === id && isOpen(w)
        );
      if (!watch) return;
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
      offForward?.();
    };
  }, [context]);

  useEffect(() => {
    const tick = setInterval(() => {
      const now = Date.now();
      const store = useTellMeWhenStore.getState();
      store.expire(now);
      for (const watch of store.timeOut(now)) {
        coalescer.current?.push({
          watch,
          verdict: { says: "timedOut", detail: watch.baseline?.seen ?? null },
        });
      }
    }, TIMEOUT_EVERY_MS);
    return () => clearInterval(tick);
  }, []);
}
