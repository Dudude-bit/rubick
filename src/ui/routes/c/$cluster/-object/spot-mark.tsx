/**
 * The one mark this whole thing turns on.
 *
 * A node going away is normally an incident; on a spot pool it is Tuesday, and
 * the mark is what tells those two apart before anyone starts looking for a
 * cause. It follows the app's existing mark discipline — plain small text in a
 * role colour, the same shape `cordoned` takes on the Overview — rather than a
 * chip, because a bordered badge would out-shout the status beside it.
 *
 * It only ever appears when a label said so. Nothing anywhere states that a
 * node is *not* spot, because on most clusters nothing knows.
 */
export function SpotMark({ says }: { says: string }) {
  return <span className="text-[11px] text-warn">{says}</span>;
}
