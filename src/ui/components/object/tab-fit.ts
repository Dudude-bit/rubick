/**
 * Which tabs a strip `room` pixels wide shows: the open one, then every tab in
 * order while the next still fits beside the menu that holds the rest. A tab
 * is shown whole or not at all. Tabs `shown` last time stay while they fit,
 * so opening one of them moves nothing and one from the menu displaces as
 * few as it needs, from the end.
 */
export function fitTabs({
  widths,
  room,
  gap,
  menu,
  open,
  shown: before,
}: {
  widths: readonly number[];
  room: number;
  gap: number;
  /** The width of the menu that takes whatever does not fit. */
  menu: number;
  /** The open tab's index, or -1. */
  open: number;
  /** Which tabs the strip showed before, by index. */
  shown?: readonly boolean[];
}): boolean[] {
  const total =
    widths.reduce((sum, width) => sum + width, 0) +
    gap * Math.max(0, widths.length - 1);
  if (total <= room) return widths.map(() => true);

  const used = (set: readonly boolean[]) => {
    let px = 0;
    let count = 0;
    set.forEach((on, index) => {
      if (!on) return;
      px += widths[index];
      count += 1;
    });
    return px + gap * Math.max(0, count - 1);
  };
  const limit = room - menu;
  const shown = widths.map((_, index) => before?.[index] ?? false);
  if (open >= 0) shown[open] = true;
  for (let index = shown.length - 1; index >= 0; index -= 1)
    if (used(shown) > limit && index !== open) shown[index] = false;
  if (used(shown) > limit) return widths.map(() => false);
  for (let index = 0; index < shown.length; index += 1) {
    if (shown[index]) continue;
    shown[index] = true;
    if (used(shown) <= limit) continue;
    shown[index] = false;
    break;
  }
  return shown;
}

/** A part of a label that can be cut: its own width, and the least it is cut to. */
export interface CutPart {
  natural: number;
  floor: number;
}

/**
 * Each part's width when together they get `budget` pixels: the longest are
 * cut first, all to one length, and none under its floor, so a short part is
 * never cut while a long one still has characters to give.
 */
export function squeeze(parts: readonly CutPart[], budget: number): number[] {
  const at = (level: number) =>
    parts.map((part) => Math.min(part.natural, Math.max(part.floor, level)));
  const sum = (level: number) =>
    at(level).reduce((total, width) => total + width, 0);
  if (sum(Infinity) <= budget) return parts.map((part) => part.natural);
  let low = 0;
  let high = Math.ceil(Math.max(0, ...parts.map((part) => part.natural)));
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (sum(mid) <= budget) low = mid;
    else high = mid - 1;
  }
  return at(low);
}

/** A tab as the strip measures it: what never shrinks, and the parts that may be cut. */
export interface StripTab {
  chrome: number;
  parts: readonly CutPart[];
}

/**
 * A strip of tabs that each size to their own label up to `cap`. Which tabs
 * fit is decided at their floors, as `fitTabs` does; the room left over goes
 * back to the shown tabs' parts by `squeeze`, so only a long part is cut and
 * only as far as the strip needs.
 */
export function fitStrip({
  tabs,
  room,
  gap,
  menu,
  open,
  cap,
  shown: before,
}: {
  tabs: readonly StripTab[];
  room: number;
  gap: number;
  menu: number;
  open: number;
  cap: number;
  shown?: readonly boolean[];
}): { shown: boolean[]; widths: number[][] } {
  const parts = tabs.map((tab) => {
    const capped = squeeze(tab.parts, cap - tab.chrome);
    return tab.parts.map((part, index) => ({
      natural: capped[index],
      floor: Math.min(part.floor, capped[index]),
    }));
  });
  const floorOf = (index: number) =>
    tabs[index].chrome +
    parts[index].reduce((sum, part) => sum + part.floor, 0);
  const shown = fitTabs({
    widths: tabs.map((_, index) => floorOf(index)),
    room,
    gap,
    menu,
    open,
    shown: before,
  });
  const kept = tabs.flatMap((_, index) => (shown[index] ? [index] : []));
  const budget =
    room -
    (kept.length < tabs.length ? menu : 0) -
    gap * Math.max(0, kept.length - 1) -
    kept.reduce((sum, index) => sum + tabs[index].chrome, 0);
  const cut = squeeze(
    kept.flatMap((index) => parts[index]),
    budget
  );
  let at = 0;
  const widths = parts.map((own, index) => {
    if (!shown[index]) return own.map((part) => part.natural);
    const mine = cut.slice(at, at + own.length);
    at += own.length;
    return mine;
  });
  return { shown, widths };
}
