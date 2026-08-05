import { Section, SectionHeader } from "@/components/ui/section";
import { ResourceType } from "@/lib/resource-registry";
import { ResourceLink } from "./detail-blocks";

/**
 * The Secrets a pod pulls its images with.
 *
 * One name per row, on the canvas. The previous version drew a bordered chip
 * per secret and linked each to `/configuration/secrets/...`, which is not a
 * route — every chip was a dead end.
 */

interface ImagePullSecretsProps {
  secrets: string[];
  namespace?: string;
}

export function ImagePullSecrets({
  secrets,
  namespace,
}: ImagePullSecretsProps) {
  return (
    <Section>
      <SectionHeader title="Image pull secrets" count={secrets.length} />
      {secrets.length === 0 ? (
        <p className="py-1 text-xs text-fg-fnt">None configured</p>
      ) : (
        secrets.map((name) => (
          <div
            key={name}
            className="border-b border-hair py-1 text-xs last:border-b-0"
          >
            {/* A Secret detail page is namespaced; without a namespace there
             *  is nowhere to link to, so the name stands on its own. */}
            {namespace ? (
              <ResourceLink
                kind={ResourceType.Secret}
                name={name}
                namespace={namespace}
              />
            ) : (
              <span className="font-mono text-fg">{name}</span>
            )}
          </div>
        ))
      )}
    </Section>
  );
}
