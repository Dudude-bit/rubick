import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";

import { claimedByTarget } from "@/hooks/useCopyLink";
import {
  CHORD_MS,
  chordsOf,
  DETAIL_TAB_OPEN,
  pageKeysOf,
} from "@/lib/shortcuts";
import { useShortcutsOverlayStore } from "@/stores/shortcutsOverlayStore";

/** A Radix layer is up, and its own keys come first. */
function aLayerIsOpen(): boolean {
  return document.querySelector('[role="dialog"][data-state="open"]') !== null;
}

/**
 * The keys that are the same on every screen: `?` for the list of them,
 * `g` then a letter to go somewhere, and a letter to open a tab of the page
 * the reader is on.
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
      if (claimedByTarget(event.target) || aLayerIsOpen()) return;
      const key = event.key;

      if (key === "?") {
        event.preventDefault();
        useShortcutsOverlayStore.getState().toggle();
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
          navigate(chord.path);
        }
        return;
      }

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
