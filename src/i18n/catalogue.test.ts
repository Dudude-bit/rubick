import { describe, expect, it } from "vitest";

import { RESOURCE_REGISTRY, toPlural } from "@/lib/resource-registry";
import { en } from "./catalogue";
import { ru } from "./ru";

/**
 * The one rule about catalogue content that a type cannot state.
 *
 * A nav row names a destination, and most of them are resource kinds whose
 * labels come from the registry — `getDisplayPlural(kind)` — precisely because
 * a Kubernetes kind is a proper noun: "Pods" is the same word in Moscow, and
 * `kubectl get поды` answers nothing. The tempting contribution is to add
 * `pods: "Поды"` here and wire the rail to it, which reads like a translation
 * and is the app inventing vocabulary the cluster does not share.
 *
 * Checked against English only, because English is the gate: the `Catalogue`
 * type is derived from `en`, so a key cannot reach any other language without
 * being spelled out here first — in the kind's own name, which is the spelling
 * this catches. A Russian catalogue holds "Поды", which no set of English kind
 * names could ever match.
 *
 * Scoped to `nav` on purpose. Elsewhere a collision is ordinary English:
 * `columns.ready` is a column of replica counts, `activity.jobs` is the app's
 * own background work, and neither is the kind that shares its spelling. The
 * status side of this rule lives where it belongs — an ESLint guard rejects
 * `<StatusBadge status={t(...)}>`, because a status is only dangerous once it
 * is passed as one.
 */
describe("what may not be put in the nav catalogue", () => {
  const kinds = new Set<string>();
  for (const definition of RESOURCE_REGISTRY) {
    kinds.add(definition.kind.toLowerCase());
    kinds.add(toPlural(definition.kind).toLowerCase());
  }

  it("names no resource kind", () => {
    const offenders = Object.entries(en.nav).filter(([, text]) =>
      kinds.has(text.toLowerCase())
    );
    expect(offenders).toEqual([]);
  });
});

/**
 * The settings search matches on a row's label, its hint, and a string of
 * synonyms nobody sees. Those synonyms are the only catalogue entries whose
 * translation must *keep* the English: somebody looking for the theme row
 * types "тема", and somebody looking for the tools row types `kubectl` —
 * the same person, on the same day. A translation that replaced the
 * technical words would take the second search away without anybody
 * noticing, because nothing on screen would change.
 */
describe("the words the settings search matches on", () => {
  const keys = Object.keys(en.settings).filter(
    (key) => key.startsWith("search") && key.endsWith("Words")
  ) as Array<keyof typeof en.settings>;

  it("has some", () => {
    expect(keys.length).toBeGreaterThan(5);
  });

  it.each(keys)("keeps every English term in ru.%s", (key) => {
    const english = String(en.settings[key]).split(/\s+/);
    const russian = String(ru.settings[key]);
    for (const word of english) {
      expect(russian).toContain(word);
    }
  });

  it.each(keys)("adds Russian to ru.%s", (key) => {
    expect(String(ru.settings[key])).toMatch(/[а-яё]/i);
  });
});
