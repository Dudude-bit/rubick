import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { Link2, TriangleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useClusterStore } from "@/stores/clusterStore";
import { useDeepLinkStore } from "@/stores/deepLinkStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useT } from "@/i18n/useT";
import { formatWhen } from "@/lib/utils";

/** One spelling of a path, whichever of its characters arrived encoded. */
const plain = (path: string) => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

/**
 * What the reader needs to know about the link that brought them here, until
 * they say they have read it or go somewhere else.
 */
export function DeepLinkBanner() {
  const t = useT();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const arrival = useDeepLinkStore((s) => s.arrival);
  const dismiss = useDeepLinkStore((s) => s.dismiss);
  const openSettings = useSettingsStore((s) => s.openSettings);

  // Leaving the page the link opened is reading the banner; it should not
  // follow the reader around the app.
  const arrivedAt = arrival ? arrival.link.path.split("?")[0] : null;
  useEffect(() => {
    if (
      arrival?.status === "live" &&
      arrivedAt &&
      plain(pathname) !== plain(arrivedAt)
    ) {
      dismiss();
    }
  }, [arrival, arrivedAt, pathname, dismiss]);

  if (!arrival) return null;

  if (arrival.status === "live") return null;

  return (
    <div
      role="alert"
      className="flex items-start gap-2 border-b border-hair bg-hover px-4 py-2 text-xs text-fg-mid"
    >
      <TriangleAlert
        className="mt-0.5 h-3.5 w-3.5 flex-none text-warn"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="text-fg">
          {t("cluster", "linkContextMissing", {
            context: arrival.link.context,
          })}
        </p>
        <p className="mt-0.5 text-fg-mut">
          {arrival.known.length > 0
            ? t("cluster", "linkContextMissingKnown", {
                known: arrival.known.join(", "),
              })
            : t("cluster", "linkContextMissingNone")}
        </p>
        <div className="mt-2 flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              dismiss();
              openSettings("clusters");
            }}
          >
            {t("cluster", "linkOpenClusters")}
          </Button>
          <Button variant="outline" size="sm" onClick={dismiss}>
            {t("cluster", "linkDismiss")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** How long the note stays once nobody is pointing at it. */
export const LINK_NOTE_MS = 12_000;

/** The live link's arrival, once its own cluster has connected. */
function useLiveArrival() {
  const arrival = useDeepLinkStore((s) => s.arrival);
  // "Live" is a claim about the connection: until the link's own cluster has
  // connected, there is nothing live to say.
  return useClusterStore(
    (s) =>
      arrival?.status === "live" &&
      s.isConnected &&
      s.currentContext === arrival.link.context
  );
}

/**
 * The live link's note, in the status bar so it covers no page, log footer
 * or toast, gone on its own a few seconds after it was last pointed at.
 */
export function LinkOpenedNote() {
  const arrival = useDeepLinkStore((s) => s.arrival);
  const live = useLiveArrival();
  if (!live || arrival?.status !== "live") return null;
  return (
    <LiveNote key={arrival.link.path} capturedAt={arrival.link.capturedAt} />
  );
}

function LiveNote({ capturedAt }: { capturedAt: Date | null }) {
  const t = useT();
  const dismiss = useDeepLinkStore((s) => s.dismiss);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held) return;
    const timer = setTimeout(dismiss, LINK_NOTE_MS);
    return () => clearTimeout(timer);
  }, [held, dismiss]);

  const text = capturedAt
    ? t("cluster", "linkOpenedAt", { when: formatWhen(capturedAt) })
    : t("cluster", "linkOpened");
  const [sentence, cut] = useCut(text);
  return (
    <span
      role="status"
      data-testid="link-opened"
      data-link-note=""
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      className="flex h-6 min-w-0 items-center gap-1.5 text-fg-mid"
    >
      <Link2 className="h-3 w-3 flex-none text-info" aria-hidden="true" />
      <span
        ref={sentence}
        title={cut ? text : undefined}
        className="min-w-0 truncate"
      >
        {text}
      </span>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t("cluster", "linkDismiss")}
        className="flex-none rounded p-0.5 text-fg-fnt hover:text-fg"
      >
        <X className="h-3 w-3" aria-hidden="true" />
      </button>
    </span>
  );
}

/** Whether the text no longer fits its box, so the whole of it is offered on hover and only then. */
function useCut(text: string) {
  const ref = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const measure = () => setCut(box.scrollWidth > box.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [text]);
  return [ref, cut] as const;
}
