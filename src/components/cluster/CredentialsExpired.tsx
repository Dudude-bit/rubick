/**
 * The screen for a session the cluster has stopped accepting.
 *
 * It replaces the whole page because the whole page is wrong. A `401` is not
 * about the request that got it: the token this window was built with is
 * refused for everything, so every list, every count and every chart behind
 * this is empty or stale — and a failed list renders its *empty* state, which
 * tells the reader on every screen at once that their cluster has no pods in
 * it. A banner over a page of zeroes leaves the zeroes on screen.
 *
 * Not `ClusterFrontDoor`: that is for a window with no cluster and answers
 * with the list to pick from. This reader has a cluster, knows which one, and
 * needs to be let back in — so the screen names the cluster, says what expired
 * and when, gives the API server's own sentence for anyone who has to paste it
 * somewhere, and offers one button.
 *
 * Sign in again re-runs `connect`, the only path that reaches
 * `prepare_kubeconfig_for_context` and therefore the only one that runs the
 * credential plugin: a plugin that can refresh without a human returns
 * silently in a second, one that needs `gcloud auth login` opens the same
 * interactive flow the first connect uses. The button promises no more than
 * "try the thing that worked the first time", which is all it can do while
 * nothing renews credentials on its own.
 */

import { useState } from "react";
import { KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useClusterInfo } from "@/hooks/useClusterInfo";
import { useRealtimeAge } from "@/hooks/useRealtimeAge";
import { verbatim } from "@/lib/error-utils";
import { useClusterStore } from "@/stores/clusterStore";
import type { ExpiredCredentials } from "@/lib/credentials";
import { useT } from "@/i18n/useT";

export function CredentialsExpired({
  expired,
}: {
  expired: ExpiredCredentials;
}) {
  const t = useT();
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
            ? t("cluster", "sessionRefusedNamed", { context })
            : t("cluster", "sessionRefused")}
        </h2>
      </div>

      <p className="text-xs text-fg-mut">
        {deadline
          ? t("cluster", "credentialsExpiredAgo", { since })
          : t("cluster", "credentialsRefusedAgo", { since })}
        {t("cluster", "credentialsExpiredBody")}
      </p>

      {/* The server's own words, never paraphrased. Somebody is going to paste
          this into a search or a ticket. */}
      <p className="select-text wrap-break-word font-mono text-[11px] text-fg-fnt">
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
          {isAuthenticating
            ? t("cluster", "signingIn")
            : t("cluster", "signInAgain")}
        </Button>
        {/* Said only after a press: before one, it would be an instruction to
            do something the reader has not tried yet. */}
        {tried && !isAuthenticating && (
          <span className="text-[11px] text-fg-fnt">
            {t("cluster", "stillRefusedHint")}{" "}
            <span className="select-text font-mono">gcloud auth login</span>.
          </span>
        )}
      </div>
    </div>
  );
}
