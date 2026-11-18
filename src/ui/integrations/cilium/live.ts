/**
 * Hubble Relay's flows, as they happen: one backend stream per caller,
 * listened to before it is let go, and closed with its caller.
 */
import { commands } from "@/lib/commands";
import { listenEvent } from "@/lib/events";
import type { LiveListener } from "@/lib/traffic";

export function openLiveFlows(
  scope: string[] | null,
  listener: LiveListener
): () => void {
  let id: string | null = null;
  let left = false;
  const listening = Promise.all([
    listenEvent("hubble-flows", ({ payload }) => {
      if (payload.stream_id !== id || left) return;
      listener.batch({
        pairs: payload.pairs,
        gone: payload.gone,
        relay: payload.relay,
        lost: payload.lost,
        untracked: payload.untracked,
        unreached: payload.unreached,
      });
    }),
    listenEvent("hubble-flows-ended", ({ payload }) => {
      if (payload.stream_id !== id || left) return;
      listener.ended(payload.end);
    }),
  ]);
  void (async () => {
    try {
      await listening;
      if (left) return;
      const opened = await commands.openHubbleFlows(scope);
      if (left) {
        void commands.closeHubbleFlows(opened).catch(() => {});
        return;
      }
      id = opened;
      await commands.hubbleFlowsSubscribed(opened);
    } catch (error) {
      if (!left) listener.failed(error);
    }
  })();
  return () => {
    left = true;
    void listening.then((offs) => offs.forEach((off) => off()));
    if (id) void commands.closeHubbleFlows(id).catch(() => {});
  };
}
