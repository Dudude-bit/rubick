/**
 * The app's one reading of a click on something that has a destination.
 *
 * `ResourceRef` established the contract and the browser taught it: plain
 * opens the thing, ctrl/cmd/middle collect it in a tab behind, shift opens
 * one in front, alt belongs to the platform. Every surface with an href
 * routes through here, so a modifier means the same thing on a list row's
 * whitespace as it does on the name inside it.
 *
 * @module hooks/useLinkGesture
 */

import { useCallback } from "react";

import { useScopeTabStore } from "@/stores/scopeTabStore";

export type LinkIntent = "activate" | "tab-behind" | "tab-front" | "none";

/**
 * The parts of a mouse or keyboard event the gesture is read from. Enter on
 * a focused row is an activation like any other, and it carries modifiers,
 * so it goes through the same reader — it simply has no `button`.
 */
export interface GestureEvent {
  button?: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  preventDefault: () => void;
}

export function readLinkIntent(
  event: Omit<GestureEvent, "preventDefault">
): LinkIntent {
  const button = event.button ?? 0;
  // `auxclick` fires for the right button too, and a context menu is not a
  // navigation — reading modifiers first would turn ctrl+right-click into
  // a new tab and eat the menu.
  if (button !== 0 && button !== 1) return "none";
  if (button === 1) return "tab-behind";
  if (event.metaKey || event.ctrlKey) return "tab-behind";
  if (event.shiftKey) return "tab-front";
  // Alt-click is the platform's own gesture; the app does not get to take it.
  if (event.altKey) return "none";
  return "activate";
}

/**
 * Handle a gesture on something with an `href`. `activate` is what a plain
 * click means for that surface — a peek for a reference, a navigation for a
 * list row — and everything modified is the same for both.
 */
export function useLinkGesture() {
  const openTab = useScopeTabStore((state) => state.openTab);

  return useCallback(
    (event: GestureEvent, href: string, activate: () => void) => {
      const intent = readLinkIntent(event);
      if (intent === "none") return;
      // The webview has no second window to hand this to, so the tab the
      // browser would have opened is a scope tab — the same promise, kept.
      event.preventDefault();
      if (intent === "activate") activate();
      else openTab({ href, background: intent === "tab-behind" });
    },
    [openTab]
  );
}
