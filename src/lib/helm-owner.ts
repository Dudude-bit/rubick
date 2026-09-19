import { helmReleaseOf } from "@/lib/changes";

/**
 * The Helm release an object says installed it.
 *
 * Helm writes `meta.helm.sh/release-name` onto everything it applies, so the
 * way back from an object to its release is on the object itself and needs no
 * read. Until now only the Changes tab asked — it wanted the release's
 * history — and nothing on screen said where a Deployment had come from, so
 * the Resources list on a release page was a one-way door.
 *
 * What comes back is what the object **claims**. A release that was
 * uninstalled leaves its annotations behind on anything Helm did not own, so
 * the release page is where "it is not there any more" gets answered; saying
 * it here would mean a read on every detail page to disprove a label.
 */
export function helmOwnerOf(
  object: unknown
): { name: string; namespace: string } | null {
  if (!object || typeof object !== "object") return null;
  const record = object as {
    annotations?: Record<string, string> | null;
    namespace?: string | null;
  };
  if (!record.annotations) return null;
  return helmReleaseOf(record.annotations, record.namespace ?? "");
}

/** Where its page is. Helm's own releases are read from the cluster. */
export function helmReleasePath(release: {
  name: string;
  namespace: string;
}): string {
  return `/helm/native/${release.namespace}/${release.name}`;
}
