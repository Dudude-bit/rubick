/**
 * Whether the OS window is on screen, whether it has focus, and when the
 * reader last touched it — three window-level facts the app polls against,
 * held in one place because they belong to the window, not any screen in it.
 *
 * A DOM and a Tauri source feed each fact on purpose: only
 * `document.visibilityState` knows the webview was occluded or minimised, and
 * only `tauri://focus`/`blur` reliably knows the *window* lost focus on Linux,
 * where a webview keeps DOM focus after the window manager moves on.
 *
 * @module lib/window-activity
 */

import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";

interface WindowActivity {
  /** The window is on screen at all — not minimised, not fully occluded. */
  visible: boolean;
  /** The window has focus. False while it is visible but beside the work. */
  focused: boolean;
  /**
   * When the reader last did something in the window.
   *
   * A pointer or a key press means they are reading *now*, which retires
   * whatever the backoff had concluded from a still screen. Throttled, because
   * this exists to reset a timer and not to measure typing.
   */
  interactionAt: number;
}

// Focused until something says otherwise, rather than whatever
// `document.hasFocus()` reports at load. The consequence of guessing wrong
// runs one way: a window wrongly believed unfocused polls at the cap and the
// reader watches a screen that has quietly stopped keeping up, while a window
// wrongly believed focused merely costs what the app cost before. Some
// environments — a webview under a bare X server, a window opened behind
// another — answer `false` at load and never send a focus event to correct it.
const initial = (): WindowActivity => ({
  visible:
    typeof document === "undefined" || document.visibilityState !== "hidden",
  focused: true,
  interactionAt: 0,
});

export const useWindowActivity = create<WindowActivity>(() => initial());

/** How often an interaction is allowed to reset the backoff. */
const INTERACTION_THROTTLE_MS = 1000;

/**
 * Start listening. Called once, by the app root; returns the teardown.
 *
 * Idempotent per call — a second call installs a second set of listeners, so
 * do not call it from a component that remounts.
 */
export function startWindowActivity(): () => void {
  if (typeof window === "undefined") return () => {};

  const set = (patch: Partial<WindowActivity>) =>
    useWindowActivity.setState((state) => {
      const next = { ...state, ...patch };
      return next.visible === state.visible && next.focused === state.focused
        ? state
        : next;
    });

  const onVisibility = () =>
    set({ visible: document.visibilityState !== "hidden" });
  const onFocus = () => set({ visible: true, focused: true });
  const onBlur = () => set({ focused: false });

  let last = 0;
  const onInteraction = () => {
    const now = Date.now();
    if (now - last < INTERACTION_THROTTLE_MS) return;
    last = now;
    useWindowActivity.setState({ interactionAt: now });
  };

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  // Capture: a handler that stops propagation must not also stop the app from
  // noticing that somebody is here.
  window.addEventListener("pointerdown", onInteraction, { capture: true });
  window.addEventListener("keydown", onInteraction, { capture: true });
  window.addEventListener("wheel", onInteraction, {
    capture: true,
    passive: true,
  });

  const unlisten: Array<() => void> = [];
  void listen("tauri://focus", onFocus).then((off) => unlisten.push(off));
  void listen("tauri://blur", onBlur).then((off) => unlisten.push(off));

  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("pointerdown", onInteraction, {
      capture: true,
    });
    window.removeEventListener("keydown", onInteraction, { capture: true });
    window.removeEventListener("wheel", onInteraction, { capture: true });
    for (const off of unlisten) off();
  };
}
