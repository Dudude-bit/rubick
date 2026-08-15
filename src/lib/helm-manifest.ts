import { loadAll } from "js-yaml";

/** One object the release's stored manifest declares. */
export interface InstalledObject {
  kind: string;
  name: string;
  namespace: string | null;
}

/**
 * What the release actually put in the cluster.
 *
 * Read out of the release's own rendered manifest rather than guessed: Helm
 * stores the exact documents it applied, so every kind and name here is one
 * the release itself states. A document without both is skipped — a stray
 * `---` or a template that rendered to nothing is not an object.
 *
 * This is not linkifying YAML. The Manifest tab stays the text surface it is;
 * this parses the same string into the objects it declares, which is a
 * different question with a different answer.
 */
export function installedObjects(
  manifest: string,
  releaseNamespace: string
): InstalledObject[] {
  let documents: unknown[];
  try {
    // `json: true` is not optional here. Charts really do render a mapping
    // with the same key twice — traefik's own manifest does — and js-yaml's
    // default schema rejects the whole *string* for it, so one duplicated
    // label lost every object in the release. JSON mode takes the last
    // occurrence, which is what the API server did when it applied this.
    documents = loadAll(manifest, { json: true });
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const objects: InstalledObject[] = [];
  for (const document of documents) {
    if (!document || typeof document !== "object") continue;
    const record = document as {
      kind?: unknown;
      metadata?: { name?: unknown; namespace?: unknown };
    };
    const { kind } = record;
    const name = record.metadata?.name;
    if (typeof kind !== "string" || typeof name !== "string") continue;
    // A chart that omits `metadata.namespace` installs into the release's,
    // which is the namespace Helm passed to the apply.
    const namespace =
      typeof record.metadata?.namespace === "string"
        ? record.metadata.namespace
        : releaseNamespace;
    const key = `${kind}/${namespace}/${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    objects.push({ kind, name, namespace });
  }
  return objects;
}
