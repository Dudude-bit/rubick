/**
 * The screen for a session the cluster has stopped accepting.
 *
 * ## Why it takes the whole page
 *
 * Because the whole page is wrong. A `401` is not about the request that got
 * it: the token this window was built with is refused for everything, so every
 * list, every count and every chart behind this is either empty or stale. The
 * app used to draw them anyway — a failed list rendered its *empty* state, so
 * an expired GKE token told the reader on every screen at once that their
 * cluster had no pods in it. Replacing the page is the only honest option; a
 * banner over a page of zeroes leaves the zeroes on screen.
 *
 * ## Why it is not the front door
 *
 * `ClusterFrontDoor` is for a window with no cluster, and its answer is the
 * list of clusters to pick from. This reader has a cluster, knows which one,
 * and needs exactly one thing: to be let back in. So the screen names the
 * cluster, says what expired and when, gives the API server's own sentence for
 * anyone who has to paste it somewhere, and offers one button.
 *
 * Sign in again re-runs `connect`, which is what runs the credential plugin —
 * `prepare_kubeconfig_for_context` is only ever reached from there. On a
 * context whose plugin can refresh without a human that returns silently in a
 * second; on one that needs `gcloud auth login` it opens the same interactive
 * flow the first connect uses. The button therefore promises no more than
 * "try the thing that worked the first time", which is all it can honestly do
 * while nothing renews credentials on its own.
 */

import { useState } from "react";
import { KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useClusterInfo } from "@/hooks/useClusterInfo";
import { useRealtimeAge } from "@/hooks/useRealtimeAge";
import { verbatim } from "@/lib/error-utils";
import { useClusterStore } from "@/stores/clusterStore";
import type { ExpiredCredentials } from "@/lib/credentials";

export function CredentialsExpired({
  expired,
}: {
  expired: ExpiredCredentials;
}) {
  const context = useClusterStore((state) => state.currentContext);
  const connect = useClusterStore((state) => state.connect);
  const isAuthenticating = useClusterStore((state) => state.isAuthenticating);
  const { data: info } = useClusterInfo();
  const [tried, setTried] = useState(false);

  // When the plugin named a deadline at connect this is the real one; where it
  // named none, how long ago the refusal arrived is the only honest timing
  // this screen has, and it is described as that rather than as an expiry.
  const deadline = info?.credentials_expire_at ?? null;
  const since = useRealtimeAge(deadline ?? new Date(expired.at).toISOString());

  return (
    <div className="mx-auto flex max-w-[68ch] flex-col gap-4 py-16">
      <div className="flex items-baseline gap-2.5">
        <KeyRound className="size-4 flex-none translate-y-0.5 text-warn" />
        <h2 className="text-[13px] font-semibold tracking-tight text-fg">
          {context
            ? `${context} is no longer accepting this session`
            : "This session is no longer accepted"}
        </h2>
      </div>

      <p className="text-xs text-fg-mut">
        {deadline
          ? `The credentials this window connected with expired ${since} ago. `
          : `The cluster refused this window's credentials ${since} ago. `}
        Nothing here renews them on its own, so every list, count and chart in
        this window stopped being answerable at that moment — which is why the
        page is this rather than a screen of empty ones.
      </p>

      {/* The server's own words, never paraphrased. Somebody is going to paste
          this into a search or a ticket. */}
      <p className="select-text break-words font-mono text-[11px] text-fg-fnt">
        {verbatim(expired.reason)}
      </p>

      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={isAuthenticating}
          onClick={() => {
            setTried(true);
            if (context) void connect(context);
          }}
        >
          {isAuthenticating ? "Signing in…" : "Sign in again"}
        </Button>
        {/* Said only after a press: before one, it would be an instruction to
            do something the reader has not tried yet. */}
        {tried && !isAuthenticating && (
          <span className="text-[11px] text-fg-fnt">
            Still refused? The credential plugin this context uses may need a
            sign-in of its own first — for GKE that is{" "}
            <span className="select-text font-mono">gcloud auth login</span>.
          </span>
        )}
      </div>
    </div>
  );
}
