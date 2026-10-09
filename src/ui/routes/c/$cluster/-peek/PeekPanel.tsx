import { Suspense, useEffect, useState } from "react";

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { usePeek, type PeekTarget } from "@/hooks/usePeek";
import { ResourceRef } from "@/components/object/ResourceRef";
import { PeekContent, preloadPeekContent } from "./peek-loader";
import { PeekSkeleton } from "./peek-skeleton";
import type { PeekTabId } from "./peek-tabs";
import { usePeekWidth } from "./peek-width";
import { SurfaceVisibility, useSurfaceVisible } from "@/lib/surface-visibility";
import { cn } from "@/lib/utils";
import { peekLanding } from "../-object/attachment";
import { usePeekHost } from "./peek-dock";
import { usePeekEscape } from "./peek-escape";

/** The sheet's `data-[state=closed]:duration-300`, with room to finish. */
const SLIDE_OUT_MS = 500;

/**
 * The right-hand drawer a reference opens.
 *
 * It answers "what is this object" without spending the page the reader is
 * already on, and — through its tabs — lets the object be worked on without
 * leaving that page either. Mounted once at the shell; everything it needs is
 * in `?peek=`, so a nested reference just rewrites that parameter and browser
 * back walks out of the peeks it opened.
 */
export function PeekPanel() {
  const { target, close } = usePeek();
  // Radix animates the close, and a panel that empties halfway through the
  // slide reads as a bug. Keep the last target on screen until it is gone.
  const [previous, setPrevious] = useState<PeekTarget | null>(target);
  if (target && target !== previous) setPrevious(target);
  const shown = target ?? previous;
  const visible = useSurfaceVisible();
  // Once the slide-out has played the body goes, and every read under it
  // with it: a mounted body is still asked again on a reconnect or a switch.
  useEffect(() => {
    if (target || !previous) return;
    const timer = window.setTimeout(() => setPrevious(null), SLIDE_OUT_MS);
    return () => window.clearTimeout(timer);
  }, [target, previous]);
  // The tab lives above the target, not inside it: clicking down a list of
  // pods with Logs open should stay on Logs rather than resetting each time.
  const [requestedTab, setRequestedTab] = useState<PeekTabId>("overview");
  usePeekEscape(!!target, close);

  // After the window has drawn, so the body is not what delays it — and
  // before the first click, so the first peek opens whole.
  useEffect(() => {
    const timer = window.setTimeout(() => void preloadPeekContent(), 1000);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    // Not modal. A peek exists to be skimmed — click a row, glance, click the
    // next — and Radix's modal mode dims the app, makes it inert and traps
    // focus, so the sidebar, the scope tabs and the very list you are reading
    // all stop responding until you close it. That is a dialog, not a peek.
    <Sheet
      open={!!target}
      modal={false}
      onOpenChange={(next) => !next && close()}
    >
      {/* No key on the panel itself: a reference clicked INSIDE the peek
          swaps the target, and remounting the sheet replayed its slide-in
          for what is a content change. The body below carries the key, so
          scroll and per-object tab state still reset. */}
      {/* The body outlives the close to keep the slide whole, and its
          queries must not outlive it with it. */}
      {shown && (
        <SurfaceVisibility.Provider value={visible && !!target}>
          <Suspense fallback={<PeekLoading target={shown} />}>
            <PeekContent
              target={shown}
              requestedTab={requestedTab}
              onTabChange={setRequestedTab}
            />
          </Suspense>
        </SurfaceVisibility.Provider>
      )}
    </Sheet>
  );
}

/** The outline the body fills in: the name from `?peek=` alone, and the overview's shape. */
function PeekLoading({ target }: { target: PeekTarget }) {
  const { width } = usePeekWidth();
  const { container, position } = usePeekHost();
  return (
    <SheetContent
      side="right"
      showOverlay={false}
      container={container}
      data-peek=""
      onEscapeKeyDown={(event) => event.preventDefault()}
      onPointerDownOutside={(event) => event.preventDefault()}
      onInteractOutside={(event) => event.preventDefault()}
      aria-describedby={undefined}
      style={{ width }}
      className={cn(
        "flex max-w-none flex-col gap-0 p-0 sm:max-w-none",
        position
      )}
    >
      <header className="flex-none px-3.5 pb-2 pt-3 pr-9">
        <SheetTitle className="flex min-w-0 items-center">
          <ResourceRef
            kind={target.kind}
            name={target.name}
            namespace={target.namespace ?? null}
            crd={target.crd}
            showKind={false}
            size="title"
            className="font-semibold"
            linkOptions={peekLanding(target)}
          />
        </SheetTitle>
      </header>
      <div className="px-3.5">
        <PeekSkeleton />
      </div>
    </SheetContent>
  );
}
