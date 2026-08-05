import {
  RESOURCE_REGISTRY,
  isResourceType,
  toKind,
  type ResourceKind,
} from "./resource-registry";

/**
 * A generated tail is what the control plane appended, not what a human
 * named — a ReplicaSet hash, a pod suffix, a CronJob's unix minute, a
 * StatefulSet ordinal. Only these shapes are treated as noise; an ordinary
 * dashed name is left whole.
 *
 * The alphabet is apimachinery's `rand.String`, which drops every vowel (and
 * 0, 1, 3) precisely so a generated suffix cannot spell a word. Matching that
 * instead of `[a-z0-9]` is what keeps a human's `-cache` or `-admin` out of
 * the tail.
 */
const GENERATED = "[bcdfghjklmnpqrstvwxz2456789]";
const POD_SUFFIX = `${GENERATED}{5}`;
const RS_HASH = `${GENERATED}{6,10}`;
const UNIX_MINUTE = "\\d{8,10}";
const TAIL = new RegExp(
  `(?:-${RS_HASH}-${POD_SUFFIX}|-${UNIX_MINUTE}(?:-${POD_SUFFIX})?|-${POD_SUFFIX}|-\\d{1,3})$`
);

export function splitName(name: string): { stem: string; tail: string } {
  const match = TAIL.exec(name);
  // index 0 would leave nothing to read; a name that is only a suffix is
  // its own stem.
  if (!match || match.index === 0) return { stem: name, tail: "" };
  return { stem: name.slice(0, match.index), tail: name.slice(match.index) };
}

/**
 * Hues for hashed identity. Evenly spread so neighbouring instances land far
 * apart. Saturation and lightness live in `--ident-s` / `--ident-l` per theme.
 */
const IDENT_HUES = [
  4, 28, 48, 92, 132, 160, 184, 202, 224, 250, 274, 296, 318, 340,
];

/**
 * FNV-1a, then murmur3's finalizer. The finalizer is not decoration: FNV-1a
 * barely mixes its low bits, and `% IDENT_HUES.length` reads exactly those,
 * so one CronJob's pods — names differing in a couple of digits — collapsed
 * onto seven of the fourteen hues. Avalanching first spreads the same batch
 * across thirteen.
 */
function hashIdentity(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 2246822507);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 3266489909);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/**
 * Seeded on the whole reference, not the tail alone: two different workloads
 * can generate the same suffix, and they must not share a colour.
 */
export function identHue(kind: string, name: string): number {
  return IDENT_HUES[hashIdentity(`${kind}/${name}`) % IDENT_HUES.length];
}

/**
 * Kind hue. The family comes from the sidebar category so the colour means
 * the same thing the navigation already taught; kinds vary inside it. Four
 * learnable families beat eighteen hues nobody can separate — the kind icon
 * carries exact identity.
 */
const FAMILY: Record<string, number> = {
  workloads: 264,
  network: 188,
  storage: 326,
  configuration: 36,
};
const FAMILY_SPREAD = 18;
const NEUTRAL_HUE = 210;

/**
 * Siblings are spread evenly across their family's band rather than hashed
 * into it. The set of kinds is a compile-time constant, and a hash over
 * fourteen of them collides — Pod and Job landed on one hue, which is the
 * single thing the spread exists to prevent.
 */
const KIND_HUES = new Map<ResourceKind, number>(
  Object.entries(FAMILY).flatMap(([category, base]) => {
    const siblings = RESOURCE_REGISTRY.filter(
      (entry) => entry.category === category
    );
    return siblings.map((entry, index): [ResourceKind, number] => {
      const position =
        siblings.length === 1 ? 0 : (index / (siblings.length - 1)) * 2 - 1;
      return [entry.kind, Math.round(base + position * FAMILY_SPREAD)];
    });
  })
);

export function kindHue(kind: string): number {
  const resolved = isResourceType(kind) ? toKind(kind) : null;
  if (!resolved) return NEUTRAL_HUE;
  return KIND_HUES.get(resolved) ?? NEUTRAL_HUE;
}
