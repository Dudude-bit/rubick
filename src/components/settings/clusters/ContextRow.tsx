import type { ContextBindingInfo, ContextInfo } from "@/generated/types";
import { clusterColor, clusterNameParts } from "@/lib/cluster-identity";
import { cn } from "@/lib/utils";
import { useClusterMark } from "@/stores/clusterIdentityStore";
import { useSettingSearchMatch } from "../settings-search";
import { VENDOR_LABEL, binaryLabel, readContext } from "./context-reading";

/**
 * One context, and the three questions every row answers: what is it, how
 * does it prove who you are, and is anything missing.
 *
 * The third is why the screen exists. Today you learn that `kubelogin` is
 * absent by pressing connect and reading an error; the file already knew,
 * and so did PATH.
 *
 * There is no connect button here. The front door and the sidebar own
 * connecting, and a second cluster switcher hidden in Settings is how two
 * of them drift apart.
 */
export function ContextRow({
  context,
  binding,
  binaries,
  connected,
  onBind,
}: {
  context: ContextInfo;
  binding: ContextBindingInfo | undefined;
  binaries: Map<string, string | null>;
  connected: boolean;
  onBind: (context: string) => void;
}) {
  const reading = readContext(context, { binaries, binding, connected });
  const visible = useSettingSearchMatch(reading.searchText);
  const mark = useClusterMark(context.name);
  const colour = clusterColor(context.name, mark.hue);
  const { prefix, label } = clusterNameParts(context.name);

  const missing = reading.missingBinary;
  const blocked = missing !== null;
  // A plugin whose binary is missing has a louder problem than an unset
  // profile, and one problem per row is the budget.
  const unbound =
    !blocked && reading.bound === null && reading.needs !== null
      ? reading.vendor
      : null;

  return (
    <div
      className={cn(
        "grid grid-cols-[10px_minmax(0,1fr)_auto] items-start gap-x-3 border-b border-hair py-2.5",
        !visible && "hidden"
      )}
      hidden={!visible}
    >
      <span
        className={cn(
          "mt-[5px] h-1.5 w-1.5 rounded-full",
          blocked && "bg-err",
          connected && "ring-[3px] ring-ok/20"
        )}
        style={
          blocked
            ? undefined
            : connected
              ? { background: colour }
              : { boxShadow: `inset 0 0 0 1.5px ${colour}` }
        }
        aria-hidden
      />

      <div className="min-w-0">
        <div className="truncate font-mono text-xs">
          {prefix && <span className="text-fg-fnt">{prefix}</span>}
          <span style={{ color: colour }}>{label}</span>
        </div>
        {context.server && (
          <div className="truncate font-mono text-[11px] text-fg-fnt">
            {context.server}
          </div>
        )}
        <div className="mt-1 text-[11px] text-fg-mut">
          {reading.how}
          {reading.bound && (
            <button
              type="button"
              onClick={() => onBind(context.name)}
              className="ml-2 rounded-[3px] border border-hair px-1.5 py-px align-[1px] text-[10px] text-fg-mut transition-colors hover:border-fg-fnt hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-info"
            >
              {VENDOR_LABEL[reading.bound.vendor]} profile{" "}
              <span className="font-mono">{reading.bound.profile}</span>
            </button>
          )}
        </div>

        {missing && (
          <div className="mt-1 text-[11px] text-err">
            <span className="font-mono">{binaryLabel(missing)}</span> is not on
            the PATH this app sees, so connecting will fail. Install it, or put
            its directory on that PATH and restart the app.
          </div>
        )}

        {/* An unbound plugin is not broken, so this is a warning and not a
            failure — but it is the fact somebody debugging a wrong-account
            403 came for, so it is on the row rather than in a Bindings tab. */}
        {unbound && unbound !== "aws" && (
          <div className="mt-1 text-[11px] text-warn">
            No {VENDOR_LABEL[unbound]} profile is bound, so it will use whatever{" "}
            <span className="font-mono">
              {binaryLabel(reading.needs ?? "")}
            </span>{" "}
            defaults to.{" "}
            <button
              type="button"
              onClick={() => onBind(context.name)}
              className="text-info hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-info"
            >
              Bind one
            </button>
          </div>
        )}
        {unbound === "aws" && (
          <div className="mt-1 text-[11px] text-fg-fnt">
            This app has no AWS profiles, so it will use whatever{" "}
            <span className="font-mono">aws</span> defaults to —{" "}
            <span className="font-mono">$AWS_PROFILE</span>, then the default
            profile.
          </div>
        )}
      </div>

      <span
        className={cn(
          "whitespace-nowrap text-[11px]",
          reading.status === "connected"
            ? "text-ok"
            : blocked
              ? "text-err"
              : "text-fg-fnt"
        )}
      >
        {reading.status}
      </span>
    </div>
  );
}
