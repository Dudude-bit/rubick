/**
 * Which tabs a strip `room` pixels wide shows: the open one, then every tab in
 * order while the next still fits beside the menu that holds the rest. A tab
 * is shown whole or not at all.
 */
export function fitTabs({
  widths,
  room,
  gap,
  menu,
  open,
}: {
  widths: readonly number[];
  room: number;
  gap: number;
  /** The width of the menu that takes whatever does not fit. */
  menu: number;
  /** The open tab's index, or -1. */
  open: number;
}): boolean[] {
  const total =
    widths.reduce((sum, width) => sum + width, 0) +
    gap * Math.max(0, widths.length - 1);
  if (total <= room) return widths.map(() => true);

  const shown = widths.map(() => false);
  let used = 0;
  const take = (index: number) => {
    const next = used + (used > 0 ? gap : 0) + widths[index];
    if (next > room - menu) return false;
    used = next;
    shown[index] = true;
    return true;
  };
  if (open >= 0) take(open);
  for (let index = 0; index < widths.length; index += 1)
    if (index !== open && !take(index)) break;
  return shown;
}
