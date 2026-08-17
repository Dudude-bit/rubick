/**
 * Which language the interface is read in.
 *
 * A reader preference, so it lives beside the other reader preferences in
 * localStorage rather than in the cluster-side config: it says something about
 * the person at the keyboard, not about the installation, and it has to be
 * available before the first render rather than after a round trip.
 *
 * `null` means "match the system", which is the default and stays the default
 * — it is not resolved to a concrete language on first launch, so somebody who
 * changes their OS language gets the app in it without having to know this
 * setting exists.
 *
 * @module stores/localeStore
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { localeFrom, type Locale } from "@/i18n";

interface LocaleState {
  /** The chosen language, or `null` for "whatever the system says". */
  choice: Locale | null;
  setChoice: (choice: Locale | null) => void;
}

export const useLocaleStore = create<LocaleState>()(
  persist(
    (set) => ({
      choice: null,
      setChoice: (choice) => set({ choice }),
    }),
    { name: "locale", version: 1 }
  )
);

/**
 * The system's language, as the webview reports it.
 *
 * `navigator.language` is the OS locale inside a Tauri webview on all three
 * platforms, which is one fewer plugin than asking Tauri for it.
 */
export function systemLocale(): Locale {
  return localeFrom(
    typeof navigator === "undefined" ? undefined : navigator.language
  );
}

/** The language to render in right now. */
export function useLocale(): Locale {
  const choice = useLocaleStore((state) => state.choice);
  return choice ?? systemLocale();
}
