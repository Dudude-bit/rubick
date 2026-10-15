import type { en } from "@/i18n/catalogue";
import type { T } from "@/i18n/useT";
import { problemWords } from "@/lib/certificates";
import { describeStop } from "@/lib/connections";
import type { Finding, StopAnswer, TraefikRoute } from "./model";

const STOP_ANSWER: Record<StopAnswer, keyof typeof en.empty> = {
  dropped: "traefikRouteDropped",
  unavailable: "everyRequest503",
  unknown: "traefikRouteDroppedOr503",
};

/**
 * A finding in words, with the objects it is about kept apart from the
 * sentence: the page draws them as links, the shared file as their names,
 * and both say the same thing.
 */
export function describeFinding(
  finding: Finding,
  t: T
): {
  title: string;
  objects: TraefikRoute[];
  note: string | null;
} {
  switch (finding.kind) {
    case "stop": {
      // The same three sentences the traffic chain uses, so "no pod carries
      // app=promo" reads identically whether it was reached from a
      // Deployment or from a hostname.
      const said = describeStop(finding.stop, t);
      return {
        title: t("empty", STOP_ANSWER[finding.answer], {
          reason: said.title,
        }),
        objects: [],
        note: said.note,
      };
    }
    case "clear":
      return {
        title: t("empty", "servedInClearTitle"),
        objects: [],
        note: t("empty", "traefikClearNote", {
          n: finding.entryPoints.length,
          list: finding.entryPoints.join(", "),
        }),
      };
    case "duplicate":
      return {
        title: t("empty", "twoObjectsClaimPath", { path: finding.path }),
        ...(finding.winner
          ? {
              objects: [finding.winner],
              note: t("empty", "traefikDuplicateWinner", {
                because:
                  finding.winner.priority !== null
                    ? t("empty", "traefikPriorityDeclared", {
                        n: finding.winner.priority,
                      })
                    : t("empty", "traefikPriorityLongest"),
              }),
            }
          : {
              objects: finding.routes,
              note: finding.tied
                ? t("empty", "traefikDuplicateTied")
                : t("empty", "traefikDuplicateUnsettled"),
            }),
      };
    case "certificate": {
      if (!finding.expiry) {
        return {
          title: t("empty", "secretNotACertificate", {
            name: finding.secretName,
          }),
          objects: [],
          note: finding.read?.problem
            ? problemWords(finding.read.problem, t)
            : t("empty", "secretNotParsable"),
        };
      }
      return {
        title: `${finding.secretName} ${finding.expiry.text}`,
        objects: [],
        note: t("empty", "certExpiryBrowserNote"),
      };
    }
  }
}

/** The same finding for a file: the objects by name, then the sentence. */
export function findingDetail(finding: Finding, t: T): string | null {
  const said = describeFinding(finding, t);
  const names = [
    ...new Set(
      said.objects.map(
        (route) =>
          `${route.source.kind} ${route.source.namespace}/${route.source.name}`
      )
    ),
  ];
  const objects =
    names.length > 1
      ? `${names.slice(0, -1).join(", ")} ${t("empty", "listAnd")} ${names.at(-1)}`
      : (names[0] ?? null);
  return [objects, said.note].filter(Boolean).join(" ") || null;
}
