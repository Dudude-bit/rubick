import { useMemo, useState } from "react";
import { Share2, type LucideIcon } from "lucide-react";
import { useLocation } from "react-router-dom";

import { DetailAction } from "@/components/resources/detail-blocks";
import { Button } from "@/components/ui/button";
import { useAppInfo } from "@/hooks/useAppInfo";
import { useObjectReport, type ObjectSubject } from "@/hooks/useObjectReport";
import { useT } from "@/i18n/useT";
import { buildDeepLink } from "@/lib/deep-link";
import { iconSvg } from "@/lib/icon-svg";
import type { Report, ReportStat } from "@/lib/report";
import { frameIcons, frameWords, kindIcon, placed } from "@/lib/report-parts";
import { useClusterStore } from "@/stores/clusterStore";
import { useDisplaySettingsStore } from "@/stores/displaySettingsStore";
import { useLocale } from "@/stores/localeStore";
import { Server } from "lucide-react";

import type { ShareContribution } from "./contribution";
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
  contribute?: () => ShareContribution;
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
  look?: "button" | "detail";
}) {
  const t = useT();
  const locale = useLocale();
  const location = useLocation();
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
    const notRead = sections.flatMap((section) =>
      section.unread ? [`${section.title}: ${section.unread}`] : []
    );
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
      link: buildDeepLink(context, `${location.pathname}${location.search}`),
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
    location.pathname,
    location.search,
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
          className="h-7 gap-1.5 px-2 text-xs text-fg-mut"
          onClick={() => setOpen(true)}
          title={t("share", "shareScreen")}
        >
          <Share2 aria-hidden="true" className="h-3.5 w-3.5" />
          {t("share", "share")}
        </Button>
      )}
      <ShareDialog report={report} open={open} onOpenChange={setOpen} />
    </>
  );
}
