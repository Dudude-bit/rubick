import { useSyncExternalStore } from "react";

export const HOLD_ATTRIBUTE = "data-pointer-hold";
const QUIET_MS = 800;

let busy = false;
let over = false;
let pressed = false;
let moving = false;
let quiet: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function settle() {
  const next = over && (pressed || moving);
  if (next === busy) return;
  busy = next;
  listeners.forEach((listener) => listener());
}

const inside = (event: Event) =>
  event.target instanceof Element &&
  event.target.closest(`[${HOLD_ATTRIBUTE}]`) !== null;

const onMove = (event: PointerEvent) => {
  over = inside(event);
  moving = over;
  clearTimeout(quiet);
  quiet = setTimeout(() => {
    moving = false;
    settle();
  }, QUIET_MS);
  settle();
};
const onDown = (event: PointerEvent) => {
  over = inside(event);
  pressed = over;
  settle();
};
const onUp = () => {
  pressed = false;
  settle();
};
const onLeave = () => {
  over = false;
  settle();
};

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    document.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerdown", onDown, { capture: true });
    document.addEventListener("pointerup", onUp, { capture: true });
    document.addEventListener("pointercancel", onUp, { capture: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerdown", onDown, { capture: true });
    document.removeEventListener("pointerup", onUp, { capture: true });
    document.removeEventListener("pointercancel", onUp, { capture: true });
    document.documentElement.removeEventListener("pointerleave", onLeave);
    clearTimeout(quiet);
    busy = over = pressed = moving = false;
  };
}

/** True while a pointer is moving over, or pressed on, a table: rows under it must not shift. */
export function usePointerOnTable(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => busy,
    () => false
  );
}
