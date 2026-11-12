import type { ReleaseWithheld, WithheldDocument } from "@/generated/types";
import type { T } from "@/i18n/useT";

/**
 * A manifest document as a reader would point at it: the object it declares,
 * in the cluster's own words, and the template the chart rendered it from.
 */
function documentName(document: WithheldDocument, t: T): string {
  const object =
    document.kind && document.name
      ? `${document.kind} ${document.name}`
      : t("action", "helmDocumentNth", { n: document.position });
  return document.source ? `${object} (${document.source})` : object;
}

/**
 * One line for each document of the manifest the backend withheld something
 * in. The placeholder drawn there reads as what the chart rendered, so the
 * tab says whose it is.
 */
export function manifestWithheldWords(
  withheld: ReleaseWithheld,
  t: T
): string[] {
  return withheld.manifest.map((document) => {
    const name = documentName(document, t);
    const { what } = document;
    switch (what.says) {
      case "keys":
        return t("action", "helmWithheldKeys", {
          document: name,
          keys: what.keys.join(", "),
        });
      case "rewritten":
        return t("action", "helmWithheldRewritten", {
          document: name,
          keys: what.keys.join(", "),
        });
      case "unread":
        return t("action", "helmWithheldUnread", { document: name });
    }
  });
}

/** The same for the values, where a path stands for a key. */
export function valuesWithheldWords(withheld: ReleaseWithheld, t: T): string[] {
  return withheld.values.length > 0
    ? [t("action", "helmValuesWithheld", { keys: withheld.values.join(", ") })]
    : [];
}

/**
 * The documents withheld whole are objects the Resources tab cannot list:
 * one line each, so a short list is not read as the whole release.
 */
export function resourcesNotListedWords(
  withheld: ReleaseWithheld,
  t: T
): string[] {
  return withheld.manifest
    .filter((document) => document.what.says === "unread")
    .map((document) =>
      t("action", "helmResourcesUnread", {
        document: documentName(document, t),
      })
    );
}
