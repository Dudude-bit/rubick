/**
 * The hook a component reaches for.
 *
 * `const t = useT()` and then `t("action", "cancel")`, or
 * `t("cluster", "podCount", { n })` when something is counted. Section and key
 * are checked against the English catalogue, so a typo is a build error and
 * renaming a key finds every caller.
 *
 * Separate from the runtime so `translate()` stays callable from places that
 * are not components — a store, a toast helper, a test.
 *
 * @module i18n/useT
 */

import { useCallback } from "react";

import { useLocale } from "@/stores/localeStore";
import { translate } from "./index";
import type { en } from "./catalogue";

type Section = keyof typeof en;

/**
 * The translator itself, for the plain functions a hook cannot reach.
 *
 * A helper that builds a sentence — `noShell(pod)` and its kind — is not a
 * component, so it cannot call the hook. Taking `t` as a parameter is how it
 * still speaks the reader's language: the component calls the hook once and
 * hands it down.
 */
export type T = ReturnType<typeof useT>;

export function useT() {
  const locale = useLocale();
  return useCallback(
    <S extends Section>(
      section: S,
      key: keyof (typeof en)[S],
      values?: Record<string, string | number>
    ) => translate(locale, section, key, values),
    [locale]
  );
}
