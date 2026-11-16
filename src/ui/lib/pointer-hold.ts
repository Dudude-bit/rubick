import { useSyncExternalStore } from "react";

export const HOLD_ATTRIBUTE = "data-pointer-hold";

let over: Element | null = null;
const listeners = new Set<() => void>();

function settle(next: Element | null) {
  if (next === over) return;
  const was = over !== null;
  over = next;
  if (was !== (next !== null)) listeners.forEach((listener) => listener());
}

const tableOf = (event: Event) =>
  event.target instanceof Element
    ? event.target.closest(`[${HOLD_ATTRIBUTE}]`)
    : null;

const onPointer = (event: PointerEvent) => settle(tableOf(event));
const onLeave = () => settle(null);

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    document.addEventListener("pointermove", onPointer, { passive: true });
    document.addEventListener("pointerdown", onPointer, { capture: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    document.removeEventListener("pointermove", onPointer);
    document.removeEventListener("pointerdown", onPointer, { capture: true });
    document.documentElement.removeEventListener("pointerleave", onLeave);
    over = null;
  };
}

/**
 * True while the pointer rests on, moves over or is pressed on a table: rows
 * under it must not shift. A table that has left the page no longer holds it.
 */
export function usePointerOnTable(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => over !== null && over.isConnected,
    () => false
  );
}
