import type { Subject } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { HELM_RELEASE } from "./rules";

/** A subject as the query string holds it, and back. */
export const subjectKey = (subject: Subject) =>
  `${subject.kind}/${subject.namespace ?? ""}/${subject.name}`;

export function subjectOf(key: string | undefined): Subject | null {
  if (!key) return null;
  const [kind, namespace, ...name] = key.split("/");
  if (!kind || name.length === 0) return null;
  return { kind, namespace: namespace || null, name: name.join("/") };
}

/** A subject's kind as the reader sees it: a Kubernetes kind as written, a Helm release in words. */
export const kindWords = (kind: string, t: T, many = false) =>
  kind === HELM_RELEASE
    ? t("audit", many ? "helmReleases" : "helmRelease")
    : kind;

/** "Deployment web", or "Helm release web". */
export const subjectTitle = (subject: Subject, t: T) =>
  `${kindWords(subject.kind, t)} ${subject.name}`;
