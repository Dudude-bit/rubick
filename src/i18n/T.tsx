/**
 * A translated string as an element, for the places a hook cannot go.
 *
 * Most of the interface calls `useT()` and is done. Column definitions cannot:
 * they are module-level arrays, evaluated once at import, and turning them into
 * functions of `t` would change the signature that
 * `src/components/resources/column-widths.test.ts` reads across seventeen
 * files. TanStack renders a column's `header` through `flexRender`, inside the
 * React tree — so a component put there can use the hook the array cannot.
 *
 *     { id: "name", size: 220, header: () => <T section="columns" k="name" /> }
 *
 * Define the arrow inside the column literal, where it is created once at
 * import. An arrow rebuilt on every render is what broke the row action
 * buttons: `flexRender` treats a renderer as a component *type*, so a new
 * function each render is a new type, and the DOM node under the pointer
 * changes between mousedown and mouseup.
 *
 * @module i18n/T
 */

import type { en } from "./catalogue";
import { useT } from "./useT";

type Section = keyof typeof en;

interface TProps<S extends Section> {
  section: S;
  k: keyof (typeof en)[S];
  values?: Record<string, string | number>;
}

export function T<S extends Section>({ section, k, values }: TProps<S>) {
  const t = useT();
  return <>{t(section, k, values)}</>;
}
