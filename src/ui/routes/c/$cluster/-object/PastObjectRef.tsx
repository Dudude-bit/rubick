import { CircleOff, History, type LucideIcon } from "lucide-react";

import {
  RESOURCE_NAME_SHELL,
  ResourceName,
} from "@/components/object/ResourceName";
import type { en } from "@/i18n/catalogue";
import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";

/** Why a name an event gives is not the object there now: another took the name, or none has it. */
export type Past = "earlier" | "gone";

const MARK: Record<
  Past,
  {
    Icon: LucideIcon;
    word: keyof typeof en.readings;
    hint: keyof typeof en.readings;
  }
> = {
  earlier: { Icon: History, word: "earlierObject", hint: "earlierObjectHint" },
  gone: { Icon: CircleOff, word: "goneObject", hint: "goneObjectHint" },
};

/** A name that is not a link: following it would open whatever holds the name now, which is not this object. */
export function PastObjectRef({
  kind,
  name,
  namespace,
  past,
  showKind = true,
  showNamespace = false,
  fit = false,
}: {
  kind: string;
  name: string;
  namespace?: string | null;
  past: Past;
  showKind?: boolean;
  showNamespace?: boolean;
  /** Fills a cell of its own, and gives the name the room before the mark's word. */
  fit?: boolean;
}) {
  const t = useT();
  const { Icon, word, hint } = MARK[past];
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-baseline gap-1.5",
        fit && "@container w-full"
      )}
      title={t("readings", hint, { kind, name })}
      data-past={past}
    >
      <span className={cn(RESOURCE_NAME_SHELL, "text-fg-mut")}>
        <ResourceName
          kind={kind}
          name={name}
          namespace={showNamespace ? namespace : undefined}
          showKind={showKind}
        />
      </span>
      <span className="inline-flex flex-none items-center gap-0.5 self-center rounded bg-fg-fnt/15 px-1 py-px text-[10px] text-fg-mut">
        <Icon className="h-2.5 w-2.5" aria-hidden="true" />
        <span className={cn(fit && "sr-only @[15rem]:not-sr-only")}>
          {t("readings", word)}
        </span>
      </span>
    </span>
  );
}
