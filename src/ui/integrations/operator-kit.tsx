/**
 * What the two operator pages — CloudNativePG and Scylla — draw the same
 * way: a labelled fact, the controller's line, and an action button that stays and says why it cannot run.
 */

import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import type { en } from "@/i18n/catalogue";
import { useT } from "@/i18n/useT";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { ResourceType } from "@/lib/resource-registry";
import { TONE_TEXT } from "@/lib/tone";
import { cn } from "@/lib/utils";

type OperatorsKey = keyof typeof en.operators;

export function Fact({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-28 flex-none text-[11px] text-fg-fnt">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

export interface OperatorController {
  name: string;
  namespace: string;
  ready: number;
  desired: number;
}

/**
 * The controller's Deployment, or why there is none to show. A refused
 * Deployment list is not "no controller": `known: false` says it could not
 * be looked for.
 *
 * `known` is required: defaulted to `true`, a caller that forgot it drew a
 * refused list as "not found". And the two are told apart by colour as well
 * as by word.
 */
export function ControllerLine({
  controller,
  missing,
  known,
  reason = null,
}: {
  controller: OperatorController | null;
  missing: string;
  known: boolean;
  reason?: string | null;
}) {
  const t = useT();
  if (!controller && !known) {
    return (
      <span className={TONE_TEXT.unknown} title={reason ?? undefined}>
        {t("operators", "deploymentsUnreadable")}
      </span>
    );
  }
  if (!controller) return <span className="text-warn">{missing}</span>;
  return (
    <>
      <Link
        to={getResourceDetailUrl(
          ResourceType.Deployment,
          controller.name,
          controller.namespace
        )}
        className={cn(
          "font-mono hover:underline",
          controller.ready < controller.desired ? "text-err" : "text-fg"
        )}
      >
        {controller.name} {controller.ready}/{controller.desired}
      </Link>
      <span className="ml-2 text-fg-fnt">
        {t("operators", "inNamespace", { namespace: controller.namespace })}
      </span>
    </>
  );
}

export function OperatorActionButton<
  A extends {
    explains: OperatorsKey;
    reason: OperatorsKey | null;
    danger: boolean;
  },
>({
  action,
  label,
  busy,
  onPick,
}: {
  action: A;
  label: string;
  busy: boolean;
  onPick: (action: A) => void;
}) {
  const t = useT();
  const blocked = busy || action.reason !== null;
  return (
    <button
      type="button"
      disabled={blocked}
      onClick={() => onPick(action)}
      title={
        action.reason
          ? t("operators", action.reason)
          : t("operators", action.explains)
      }
      className={cn(
        "rounded border border-hair px-1.5 py-0.5 transition-colors",
        action.danger
          ? "text-err hover:bg-err/10"
          : "text-fg-mut hover:bg-hover hover:text-fg",
        blocked && "cursor-not-allowed opacity-50"
      )}
    >
      {label}
      {action.reason && (
        <span className="ml-1 text-fg-fnt">
          · {t("operators", action.reason)}
        </span>
      )}
    </button>
  );
}
