import { useMemo, useState } from "react";
import { Share2, type LucideIcon } from "lucide-react";

import { DetailAction } from "@/components/object/detail-blocks";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppInfo } from "@/hooks/useAppInfo";
import { useLocationHref } from "@/hooks/useLocationHref";
import { useObjectReport, type ObjectSubject } from "@/hooks/useObjectReport";
import { useT } from "@/i18n/useT";
import { buildDeepLink } from "@/lib/deep-link";
import { iconSvg } from "@/lib/icon-svg";
import type { Report, ReportStat } from "@/lib/report";
import {
  frameIcons,
  frameWords,
  kindIcon,
  placed,
  unreadLines,
} from "@/lib/report-parts";
import { useClusterStore } from "@/stores/clusterStore";
import { useDisplaySettingsStore } from "@/stores/displaySettingsStore";
import { useLocale } from "@/stores/localeStore";
import { Server } from "lucide-react";

import type { ShareContribution, ShareFrame } from "./contribution";
import { useScreenSections } from "./screen-share";
import { ShareDialog } from "./ShareDialog";

/** Share on a detail page: the object, and everything the page adds about it. */
export function ShareObjectAction({
  subject,
  resource,
  contribute,
}: {
  subject: ObjectSubject | null;
  resource: unknown;
  contribute?: (frame: ShareFrame) => ShareContribution;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { report } = useObjectReport(subject, resource, contribute, open);
  return (
    <>
      <DetailAction
        label={t("share", "share")}
        icon={Share2}
        onClick={() => setOpen(true)}
        disabled={!subject}
      />
      <ShareDialog report={report} open={open} onOpenChange={setOpen} />
    </>
  );
}

export interface ScreenSubject {
  title: string;
  /** The kind the screen lists, for its icon and hue; `null` for a screen of mixed things. */
  kind?: string | null;
  icon?: LucideIcon;
  namespace?: string | null;
  stats?: () => ReportStat[];
}

/**
 * Share on a screen: whatever the screen's shared components registered, as
 * they are drawn at the moment of pressing.
 */
export function ShareScreenAction({
  screen,
  look = "button",
}: {
  screen: ScreenSubject;
  look?: "button" | "detail" | "icon";
}) {
  const t = useT();
  const locale = useLocale();
  const href = useLocationHref();
  const context = useClusterStore((s) => s.currentContext) ?? "";
  const colouring = useDisplaySettingsStore((s) => s.resourceColouring);
  const version = useAppInfo();
  const collect = useScreenSections();
  const [open, setOpen] = useState(false);
  // Per opening, not per render: the dialog keys the public-target tick and
  // the published link on it, and a screen object built inline changes
  // identity on every watch tick.
  const capturedAt = useMemo(() => {
    void open;
    return new Date().toISOString();
  }, [open]);

  const report = useMemo<Report | null>(() => {
    if (!open || !collect || version.data === undefined) return null;
    const sections = collect();
    // A screen whose parts registered nothing still gets a file; it must not
    // be one that reads as "all of it, and all of it was read".
    const notRead =
      sections.length === 0
        ? [t("share", "screenGaveNothing")]
        : unreadLines(sections);
    const icon = screen.icon ?? (screen.kind ? kindIcon(screen.kind) : Share2);
    return {
      subject: {
        kind: screen.kind ?? "Screen",
        name: screen.title,
        namespace: screen.namespace ?? null,
        context,
      },
      hero: {
        ref: null,
        title: screen.title,
        icon: iconSvg(icon),
        hue: null,
      },
      kicker: t("share", "kickerScreen"),
      capturedAt,
      appVersion: version.data.version,
      colouring,
      status: null,
      chips: [
        ...(screen.namespace
          ? [{ icon: iconSvg(kindIcon("Namespace")), text: screen.namespace }]
          : []),
        { icon: iconSvg(Server), text: context },
      ],
      stats: screen.stats?.() ?? [],
      verdict: null,
      sections: placed(sections),
      notRead,
      link: buildDeepLink(href, new Date(capturedAt)),
      words: frameWords(t, locale, notRead.length),
      icons: frameIcons(),
    };
  }, [
    open,
    collect,
    capturedAt,
    version.data,
    screen,
    context,
    t,
    colouring,
    href,
    locale,
  ]);

  if (!collect) return null;
  return (
    <>
      {look === "detail" ? (
        <DetailAction
          label={t("share", "share")}
          icon={Share2}
          onClick={() => setOpen(true)}
        />
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className={cn(
            "h-7 gap-1.5 text-xs text-fg-mut",
            look === "icon" ? "w-7 px-0" : "px-2"
          )}
          onClick={() => setOpen(true)}
          title={t("share", "shareScreen")}
          aria-label={look === "icon" ? t("share", "shareScreen") : undefined}
        >
          <Share2 aria-hidden="true" className="h-3.5 w-3.5" />
          {look !== "icon" && t("share", "share")}
        </Button>
      )}
      <ShareDialog report={report} open={open} onOpenChange={setOpen} />
    </>
  );
}
