import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";

import { claimedByLayer, claimedByTarget } from "./useCopyLink";
import {
  CHORD_MS,
  chordsOf,
  DETAIL_TAB_OPEN,
  pageKeysOf,
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

      const first = pending.current;
      pending.current = null;
      if (first && Date.now() - first.at < CHORD_MS) {
        const chord = chordsOf().find(
          (entry) => entry.keys[0] === first.key && entry.keys[1] === key
        );
        if (chord?.path) {
          event.preventDefault();
          void navigate(chord.path);
        }
        return;
      }

      if (routeListKey(event)) return;

      if (key === "g") {
        pending.current = { key, at: Date.now() };
        return;
      }

      const page = pageKeysOf().find((entry) => entry.keys[0] === key);
      if (page?.tab) {
        window.dispatchEvent(
          new CustomEvent(DETAIL_TAB_OPEN, { detail: { tab: page.tab } })
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);
}
