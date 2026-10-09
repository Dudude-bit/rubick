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
/** Sent from an element that wrote its title under a pointer already resting on it. */
export const TITLE_SET = "title.set";

interface ShownTitle {
  text: string;
  anchor: DOMRect;
  x: number;
  y: number;
}

interface Held {
  text: string;
  labelled: boolean;
}

/** Every title from `node` up, the nearest first; a blank one hides those above it, as in WebKit. */
function titlesAbove(
  node: Element | null,
  held: ReadonlyMap<Element, Held>
): [Element, string][] {
  const found: [Element, string][] = [];
  for (let el = node; el; el = el.parentElement) {
    const text = held.get(el)?.text ?? el.getAttribute("title");
    if (text === null) continue;
    if (!text.trim()) break;
    found.push([el, text]);
  }
  return found;
}

/**
 * Takes over the `title` of whatever the pointer rests on and of every
 * titled element around it, since WebKit draws the nearest one left in
 * place, and `show` draws it instead. A press, a key, a menu or a scroll
 * puts it away until the pointer leaves.
 */
function watchTitles(show: (shown: ShownTitle | null) => void): () => void {
  const held = new Map<Element, Held>();
  let owner: Element | null = null;
  let quiet = false;
  let visible = false;
  let hiddenAt = Number.NEGATIVE_INFINITY;
  let timer = 0;
  let x = 0;
  let y = 0;
  let parkedAt: { x: number; y: number } | null = null;
  let announcing = false;

  const reveal = () => {
    const text = owner && held.get(owner)?.text;
    if (!owner || quiet || !text || !owner.isConnected) return;
    visible = true;
    show({ text, anchor: owner.getBoundingClientRect(), x, y });
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
      : new MutationObserver((records) => {
          for (const { target } of records) {
            if (!(target instanceof Element)) continue;
            const entry = held.get(target);
            if (!entry) continue;
            const again = target.getAttribute("title");
            if (again === null) {
              held.delete(target);
              if (target === owner) hide();
              continue;
            }
            entry.text = again;
            target.removeAttribute("title");
            if (visible && target === owner) reveal();
          }
          watcher?.takeRecords();
        });
  const observe = (el: Element) =>
    watcher?.observe(el, { attributes: true, attributeFilter: ["title"] });

  const take = (el: Element, text: string) => {
    el.removeAttribute("title");
    // An icon with nothing else naming it keeps its name while the title is held.
    const labelled =
      !el.hasAttribute("aria-label") &&
      !el.hasAttribute("aria-labelledby") &&
      !el.textContent?.trim();
    if (labelled) el.setAttribute("aria-label", text);
    held.set(el, { text, labelled });
    observe(el);
  };
  const holdOnly = (keep: readonly Element[]) => {
    const dropped = [...held].filter(([el]) => !keep.includes(el));
    if (dropped.length === 0) return;
    watcher?.disconnect();
    for (const [el, { text, labelled }] of dropped) {
      held.delete(el);
      if (!el.hasAttribute("title")) el.setAttribute("title", text);
      if (labelled) el.removeAttribute("aria-label");
    }
    held.forEach((_, el) => observe(el));
  };

  const release = () => {
    hide();
    holdOnly([]);
    owner = null;
    quiet = false;
  };

  const over = (event: Event) => {
    const target = event.target instanceof Element ? event.target : null;
    const titles = titlesAbove(target, held);
    holdOnly(titles.map(([el]) => el));
    for (const [el, text] of titles) if (!held.has(el)) take(el, text);
    const nearest = titles[0]?.[0] ?? null;
    if (owner && nearest === owner) return;
    hide();
    owner = nearest;
    if (event instanceof MouseEvent) {
      x = event.clientX;
      y = event.clientY;
    }
    // WebKit sends a pointerover with no movement when the row under a parked
    // pointer is redrawn; a title put away by a press stays away until it moves.
    if (parkedAt && (parkedAt.x !== x || parkedAt.y !== y)) parkedAt = null;
    quiet = parkedAt !== null;
    if (!owner) return;
    const delay =
      performance.now() - hiddenAt < SKIP_DELAY_MS ? 0 : OPEN_DELAY_MS;
    timer = window.setTimeout(reveal, delay);
  };
  const out = (event: Event) => {
    if (held.size === 0) return;
    const to =
      event instanceof MouseEvent && event.relatedTarget instanceof Node
        ? event.relatedTarget
        : null;
    if (to && [...held.keys()].some((el) => el.contains(to))) return;
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
    [document, TITLE_SET, over],
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
