import type { Subject } from "@/generated/types";

/** A subject as the query string holds it, and back. */
export const subjectKey = (subject: Subject) =>
  `${subject.kind}/${subject.namespace ?? ""}/${subject.name}`;

export function subjectOf(key: string | undefined): Subject | null {
  if (!key) return null;
  const [kind, namespace, ...name] = key.split("/");
  if (!kind || name.length === 0) return null;
  return { kind, namespace: namespace || null, name: name.join("/") };
}
