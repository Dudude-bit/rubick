/**
 * Which of a CRD's own printer columns the list draws itself.
 *
 * Name and age get their own columns — one links to the object, the other
 * ticks — so the CRD's versions of them are skipped. Its own, because a CRD
 * names its printer columns and `kubectl`'s upper-case convention is a
 * convention, not a rule: Cilium declares `Age`, which a case-sensitive
 * comparison let through, and every Cilium kind drew two Age columns with
 * the CRD's one empty beside ours.
 */
export function drawnSeparately(name: string): boolean {
  const heading = name.trim().toUpperCase();
  return heading === "NAME" || heading === "AGE";
}
