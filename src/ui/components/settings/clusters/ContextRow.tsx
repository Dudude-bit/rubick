import {
  Circle,
  CircleCheck,
  CircleHelp,
  CircleX,
  type LucideIcon,
} from "lucide-react";

import type { ContextBindingInfo, ContextInfo } from "@/generated/types";
import { Checkbox } from "@/components/ui/checkbox";
import { clusterColor, clusterNameParts } from "@/lib/cluster-identity";
import { criticalityOf } from "@/lib/critical";
import { useShownPath } from "@/lib/hide-paths";
import { cn } from "@/lib/utils";
import {
  useClusterIdentityStore,
  useClusterMark,
} from "@/stores/clusterIdentityStore";
import { useSettingSearchMatch } from "../settings-search";
import {
  VENDOR_LABEL,
  binaryLabel,
  readContext,
  type ContextStatus,
} from "./context-reading";
import { useT } from "@/i18n/useT";
import { failureLine } from "@/components/cluster/connect-failure";
import { verbatim } from "@/lib/error-utils";
import type { ConnectFailed } from "@/stores/clusterStore";

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
const CONTEXT_STATUS = {
  connected: "contextConnected",
  "not connected": "contextNotConnected",
  "connect failed": "contextConnectFailed",
  "cannot connect": "contextCannotConnect",
  "cannot tell": "contextCannotTell",
} as const;

/**
 * The status wears its own mark in a role colour. The dot and the name are
 * the colour the reader gave the cluster, and a red one beside "not
 * connected" read as a failure before anything had been tried.
 */
const STATUS_MARK: Record<ContextStatus, { icon: LucideIcon; tone: string }> = {
  connected: { icon: CircleCheck, tone: "text-ok" },
  "not connected": { icon: Circle, tone: "text-fg-fnt" },
  "connect failed": { icon: CircleX, tone: "text-err" },
  "cannot connect": { icon: CircleX, tone: "text-err" },
  "cannot tell": { icon: CircleHelp, tone: "text-fg-mut" },
};

export function ContextRow({
  context,
  binding,
  binaries,
  connected,
  failure = null,
  onBind,
  fromFile,
}: {
  context: ContextInfo;
  binding: ContextBindingInfo | undefined;
  binaries: Map<string, string | null>;
  connected: boolean;
  /** The last connect to this context failed, and has not landed since. */
  failure?: ConnectFailed | null;
  onBind: (context: string) => void;
  /**
   * Which file named this context, where more than one is being read.
   *
   * Absent with a single file — every context came from it, and repeating
   * the path on every row is noise. With a work file and a home file it is
   * the one thing the row cannot be worked out from.
   */
  fromFile?: string;
}) {
  const t = useT();
  const reading = readContext(
    context,
    { binaries, binding, connected, failed: failure !== null },
    t
  );
  const show = useShownPath();
  const visible = useSettingSearchMatch(reading.searchText);
  const mark = useClusterMark(context.name);
  const setCritical = useClusterIdentityStore((s) => s.setCritical);
  const criticality = criticalityOf(context.name, mark);
  const colour = clusterColor(context.name, mark.hue);
  const { prefix, label } = clusterNameParts(context.name);

  const status = STATUS_MARK[reading.status];
  const missing = reading.missingBinary;
  const blocked = missing !== null || reading.status === "connect failed";
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
        className="mt-[5px] h-1.5 w-1.5 rounded-full"
        style={{ background: colour }}
        aria-hidden
      />

      <div className="min-w-0">
        <div className="truncate font-mono text-xs">
          {prefix && <span className="text-fg-fnt">{prefix}</span>}
          <span style={{ color: colour }}>{label}</span>
        </div>
        {fromFile && (
          <div className="truncate font-mono text-[11px] text-fg-fnt">
            {show(fromFile)}
          </div>
        )}
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
              className="ml-2 rounded-[3px] border border-hair px-1.5 py-px align-[1px] text-[10px] text-fg-mut transition-colors hover:border-fg-fnt hover:text-fg focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info"
            >
              {t("settings", "vendorProfile", {
                vendor: VENDOR_LABEL[reading.bound.vendor],
              })}{" "}
              <span className="font-mono">{reading.bound.profile}</span>
            </button>
          )}
        </div>

        {missing && (
          <div className="mt-1 text-[11px] text-err">
            <span className="font-mono">{binaryLabel(missing)}</span>{" "}
            {t("settings", "binaryNotOnPath")}
          </div>
        )}

        {/* An unbound plugin is not broken, so this is a warning and not a
            failure — but it is the fact somebody debugging a wrong-account
            403 came for, so it is on the row rather than in a Bindings tab. */}
        {unbound && unbound !== "aws" && (
          <div className="mt-1 text-[11px] text-warn">
            {t("settings", "noProfileBoundPrefix", {
              vendor: VENDOR_LABEL[unbound],
            })}{" "}
            <span className="font-mono">
              {binaryLabel(reading.needs ?? "")}
            </span>
            {t("settings", "noProfileBoundSuffix")}{" "}
            <button
              type="button"
              onClick={() => onBind(context.name)}
              className="text-info hover:underline focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info"
            >
              {t("settings", "bindOne")}
            </button>
          </div>
        )}
        <label className="mt-1.5 flex cursor-pointer items-start gap-2 text-[11px]">
          <Checkbox
            checked={criticality.critical}
            onCheckedChange={(checked) =>
              // Unticking clears the mark back to undecided rather than storing
              // an explicit `false` — that residue would suppress the guessed
              // hint on a prod-looking name the reader never meant to overrule.
              setCritical(context.name, checked === true ? true : null)
            }
            className="mt-px"
          />
          <span className="min-w-0">
            <span className={criticality.critical ? "text-err" : "text-fg-mut"}>
              {t("settings", "criticalLabel")}
            </span>
            {criticality.guessed && (
              <span className="ml-1.5 text-warn">
                {t("settings", "criticalGuessed")}
              </span>
            )}
          </span>
        </label>

        {unbound === "aws" && (
          <div className="mt-1 text-[11px] text-fg-fnt">
            {t("settings", "awsNoProfilesPrefix")}{" "}
            <span className="font-mono">aws</span>
            {t("settings", "awsNoProfilesMid")}{" "}
            <span className="font-mono">$AWS_PROFILE</span>
            {t("settings", "awsNoProfilesSuffix")}
          </div>
        )}
      </div>

      <span
        data-testid="context-status"
        title={
          reading.status === "connect failed" && failure
            ? `${failureLine(t, failure.kind, context.name, context.server, context.exec_command)}\n\n${verbatim(failure.error)}`
            : undefined
        }
        className={cn(
          "flex items-center gap-1 whitespace-nowrap text-[11px]",
          status.tone
        )}
      >
        <status.icon className="h-3 w-3 flex-none" aria-hidden />
        {t("settings", CONTEXT_STATUS[reading.status])}
      </span>
    </div>
  );
}
