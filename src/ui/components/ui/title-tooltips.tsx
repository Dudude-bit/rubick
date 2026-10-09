import * as React from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import { TOOLTIP_CARD } from "./tooltip";

/** Radix's defaults, which every `<Tooltip>` in the app opens with. */
const OPEN_DELAY_MS = 700;
const SKIP_DELAY_MS = 300;
const GAP_PX = 4;
const EDGE_PX = 8;
/** The arrow pointer's height below its hot spot, which the card must not sit under. */
const CURSOR_PX = 20;
/** What Radix announces as one of its tooltips opens, and every open one closes on. */
export const TOOLTIP_OPEN = "tooltip.open";

interface ShownTitle {
  text: string;
  anchor: DOMRect;
  x: number;
  y: number;
}

/**
 * Takes over the `title` of whatever the pointer rests on: the attribute is
 * held while the pointer is there, so WebKit draws no box of its own, and
 * `show` draws it instead. A press, a key, a menu or a scroll puts it away
 * until the pointer leaves.
 */
function watchTitles(show: (shown: ShownTitle | null) => void): () => void {
  let owner: Element | null = null;
  let held = "";
  let labelled = false;
  let quiet = false;
  let visible = false;
  let hiddenAt = Number.NEGATIVE_INFINITY;
  let timer = 0;
  let x = 0;
  let y = 0;
  let parkedAt: { x: number; y: number } | null = null;
  let announcing = false;

  const reveal = () => {
    if (!owner || quiet || !held || !owner.isConnected) return;
    visible = true;
    show({ text: held, anchor: owner.getBoundingClientRect(), x, y });
    announcing = true;
    document.dispatchEvent(new CustomEvent(TOOLTIP_OPEN));
    announcing = false;
  };
  const hide = () => {
    window.clearTimeout(timer);
    if (!visible) return;
    visible = false;
    hiddenAt = performance.now();
    show(null);
  };
  // A title written again while held, by a re-render or by `holdTitles`
  // putting one back, is taken again; one removed by its owner is gone.
  const watcher =
    typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(() => {
          if (!owner) return;
          const again = owner.getAttribute("title");
          if (again === null) {
            held = "";
            hide();
            return;
          }
          held = again;
          owner.removeAttribute("title");
          watcher?.takeRecords();
          if (visible) reveal();
        });

  const release = () => {
    hide();
    watcher?.disconnect();
    if (owner && held && !owner.hasAttribute("title")) {
      owner.setAttribute("title", held);
    }
    if (owner && labelled) owner.removeAttribute("aria-label");
    owner = null;
    held = "";
    labelled = false;
    quiet = false;
  };

  const over = (event: Event) => {
    const target = event.target instanceof Element ? event.target : null;
    // A title inside the one held is the nearer one, and takes over from it.
    const nearer = target?.closest("[title]");
    if (
      owner &&
      target &&
      owner.contains(target) &&
      !(nearer && nearer !== owner && owner.contains(nearer))
    )
      return;
    release();
    if (event instanceof MouseEvent) {
      x = event.clientX;
      y = event.clientY;
    }
    // WebKit sends a pointerover with no movement when the row under a parked
    // pointer is redrawn; a title put away by a press stays away until it moves.
    if (parkedAt && (parkedAt.x !== x || parkedAt.y !== y)) parkedAt = null;
    quiet = parkedAt !== null;
    const found = target?.closest("[title]");
    const text = found?.getAttribute("title") ?? "";
    if (!found || !text.trim()) return;
    owner = found;
    held = text;
    found.removeAttribute("title");
    // An icon with nothing else naming it keeps its name while the title is held.
    if (
      !found.hasAttribute("aria-label") &&
      !found.hasAttribute("aria-labelledby") &&
      !found.textContent?.trim()
    ) {
      found.setAttribute("aria-label", text);
      labelled = true;
    }
    watcher?.observe(found, { attributes: true, attributeFilter: ["title"] });
    const delay =
      performance.now() - hiddenAt < SKIP_DELAY_MS ? 0 : OPEN_DELAY_MS;
    timer = window.setTimeout(reveal, delay);
  };
  const out = (event: Event) => {
    if (!owner) return;
    const to =
      event instanceof MouseEvent && event.relatedTarget instanceof Node
        ? event.relatedTarget
        : null;
    if (to && owner.contains(to)) return;
    release();
  };
  const hush = (event: Event) => {
    quiet = true;
    parkedAt =
      event instanceof MouseEvent
        ? { x: event.clientX, y: event.clientY }
        : { x, y };
    hide();
  };

  const listeners: [EventTarget, string, (event: Event) => void][] = [
    [document, "pointerover", over],
    [document, "pointerout", out],
    [document, "pointerdown", hush],
    [document, "contextmenu", hush],
    [document, "keydown", hush],
    [document, "wheel", hush],
    [document, "scroll", hush],
    [window, "blur", release],
    [
      document,
      TOOLTIP_OPEN,
      () => {
        if (!announcing) hide();
      },
    ],
  ];
  for (const [on, type, handle] of listeners) {
    on.addEventListener(type, handle, { capture: true, passive: true });
  }
  return () => {
    for (const [on, type, handle] of listeners) {
      on.removeEventListener(type, handle, { capture: true });
    }
    release();
  };
}

/**
 * Below the element and the pointer, under the pointer's x; above it where
 * there is no room below. Above, a cell's card covered the row over the one
 * being read.
 */
function TitleCard({ text, anchor, x, y }: ShownTitle) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const card = ref.current;
    if (!card) return;
    const box = card.getBoundingClientRect();
    const below = Math.max(anchor.bottom + GAP_PX, y + CURSOR_PX);
    const fits = below + box.height <= window.innerHeight - EDGE_PX;
    const side = fits ? "bottom" : "top";
    const left = Math.min(
      Math.max(x - box.width / 2, EDGE_PX),
      window.innerWidth - box.width - EDGE_PX
    );
    card.dataset.side = side;
    card.style.left = `${Math.max(left, EDGE_PX)}px`;
    card.style.top = `${
      fits ? below : Math.max(anchor.top - GAP_PX - box.height, EDGE_PX)
    }px`;
  }, [text, anchor, x, y]);
  return (
    <div
      ref={ref}
      role="tooltip"
      className={cn(
        TOOLTIP_CARD,
        "pointer-events-none fixed left-0 top-0 max-w-[min(28rem,calc(100vw-16px))] whitespace-pre-line"
      )}
    >
      {text}
    </div>
  );
}

/**
 * Every native `title` in the app, drawn in the same card as every
 * `<Tooltip>`: a tab's count, a Ctrl+K count and a cell's full text read as
 * one kind of tooltip, not as WebKit's square black box beside a rounded one.
 */
export function TitleTooltips() {
  const [shown, setShown] = React.useState<ShownTitle | null>(null);
  React.useEffect(() => watchTitles(setShown), []);
  return shown ? createPortal(<TitleCard {...shown} />, document.body) : null;
}
