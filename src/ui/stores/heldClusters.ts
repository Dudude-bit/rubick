/**
 * The clusters another surface still shows. A parked scope tab names its
 * own, and a switch in this tab must not tear that one down.
 *
 * Its own module, imported by both stores, so a test that mocks the cluster
 * store does not take the registration away from the scope tab store.
 */
let heldElsewhere: () => (string | null)[] = () => [];

export function holdClusters(held: () => (string | null)[]): void {
  heldElsewhere = held;
}

export function heldClusters(): (string | null)[] {
  return heldElsewhere();
}
