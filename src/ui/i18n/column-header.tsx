import type { en } from "./catalogue";
import { T } from "./T";

type Section = keyof typeof en;

/** The catalogue string a column's header draws, for a reader with no DOM. */
export interface HeaderSaying {
  section: Section;
  key: string;
}

/**
 * `header: () => <T …/>` with the key kept beside it, so a shared file names
 * the column in the reader's language rather than guessing from its id.
 */
export function columnHeader<S extends Section>(
  section: S,
  k: keyof (typeof en)[S]
): (() => React.JSX.Element) & { saying: HeaderSaying } {
  return Object.assign(() => <T section={section} k={k} />, {
    saying: { section, key: String(k) },
  });
}
