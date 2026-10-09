/**
 * A sentence that carries markup, kept whole in the catalogue.
 *
 * Some sentences have a styled fragment inside them — a container name in
 * mono, a status the reader has to be able to pick out. Written as JSX they
 * become two or three half-sentences either side of an element, and a
 * language that puts the fragment somewhere else has nowhere to put it: the
 * halves are fixed in place by the markup between them.
 *
 * So the catalogue keeps one string with `{name}`-style placeholders, and the
 * substitution happens here. A translator moves the placeholder wherever their
 * word order wants it, and the element follows.
 *
 *     {parts(t("empty", "podStillInInit"), { container: <Mono>{name}</Mono> })}
 *
 * Placeholders with no node are left as they arrive from `translate()`, which
 * has already filled the plain string values.
 *
 * @module i18n/parts
 */

import { Fragment, type ReactNode } from "react";

const PLACEHOLDER = /\{(\w+)\}/g;

export function parts(
  text: string,
  nodes: Record<string, ReactNode>
): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  PLACEHOLDER.lastIndex = 0;
  while ((match = PLACEHOLDER.exec(text)) !== null) {
    const node = nodes[match[1]];
    if (node === undefined) continue;
    if (match.index > last) out.push(text.slice(last, match.index));
    out.push(<Fragment key={`${match[1]}-${match.index}`}>{node}</Fragment>);
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
