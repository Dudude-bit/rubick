import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";

import { claimedByLayer, claimedByTarget } from "./useCopyLink";
import {
  CHORD_MS,
  chordsOf,
  DETAIL_TAB_OPEN,
  FIELD_PRESS_MS,
  pageKeysOf,
  TYPING_MS,
} from "@/lib/shortcuts";
import { routeListKey } from "@/lib/list-keys";
import { useShortcutsOverlayStore } from "@/stores/shortcutsOverlayStore";

/**
 * The keys that are the same on every screen: `?` or F1 for the list of them,
 * `g` then a letter to go somewhere, a letter to open a tab of the page the
 * reader is on, and whatever is left to the list on screen.
 *
 * Unmodified keys only, and never from inside a field, a terminal or an
 * open layer: those own their keys, and a `g` typed into a search box is a
 * letter.
 */
export function useShortcuts(): void {
  const navigate = useNavigate();
  const pending = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    let lastLetterAt = -Infinity;
    let fieldPressedAt = -Infinity;
    let waiting: ReturnType<typeof setTimeout> | null = null;
    const cancel = () => {
      if (waiting !== null) clearTimeout(waiting);
      waiting = null;
    };
    const soon = (act: () => void) => {
      cancel();
      if (Date.now() - fieldPressedAt < FIELD_PRESS_MS) return;
      waiting = setTimeout(() => {
        waiting = null;
        act();
      }, TYPING_MS);
    };
    const onPointer = (event: PointerEvent) => {
      if (!claimedByTarget(event.target)) return;
      fieldPressedAt = Date.now();
      cancel();
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // Help is asked for from anywhere, a field and the help itself included.
      if (event.key === "F1") {
        event.preventDefault();
        useShortcutsOverlayStore.getState().toggle();
        return;
      }
      if (claimedByTarget(event.target)) return;
      // Lowercased, as every neighbouring handler in this app does it. With
      // Caps Lock on the browser reports "G" and "P", nothing matched the
      // table, and every chord and page key died silently while the
      // modified shortcuts drawn beside them in the overlay kept working.
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

      // Before the layer test, and only this key: the list of shortcuts is
      // itself a dialog and holds the focus, so a test that steps aside for
      // layers left `?` able to open it and unable to close it again.
      const overlay = useShortcutsOverlayStore.getState();
      if (key === "?" && overlay.open) {
        event.preventDefault();
        overlay.toggle();
        return;
      }

      if (claimedByLayer(event.target)) return;

      if (key === "?") {
        event.preventDefault();
        overlay.toggle();
        return;
      }

      const now = Date.now();
      const letter = key.length === 1;
      const typing = letter && now - lastLetterAt < TYPING_MS;
      if (letter) {
        lastLetterAt = now;
        cancel();
      }

      const first = pending.current;
      pending.current = null;
      if (first && now - first.at < CHORD_MS) {
        const chord = chordsOf().find(
          (entry) => entry.keys[0] === first.key && entry.keys[1] === key
        );
        const path = chord?.path;
        if (path) {
          event.preventDefault();
          soon(() => void navigate(path));
        }
        return;
      }

      if (routeListKey(event) || typing) return;

      if (key === "g") {
        pending.current = { key, at: now };
        return;
      }

      const tab = pageKeysOf().find((entry) => entry.keys[0] === key)?.tab;
      if (tab) {
        soon(() =>
          window.dispatchEvent(
            new CustomEvent(DETAIL_TAB_OPEN, { detail: { tab } })
          )
        );
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer, { capture: true });
    return () => {
      cancel();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer, { capture: true });
    };
  }, [navigate]);
}
