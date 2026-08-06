import { CopyableValue } from "@/components/ui/copyable-value";
import { parseImageRef } from "@/lib/image-ref";

/**
 * A container image reference, split the way a resource name is: the part a
 * reader recognises at full strength, its context quieter.
 *
 * The repository is what identifies the image — `busybox`, `project/sub/app`.
 * The registry that hosts it and the tag that versions it are context, so they
 * drop a step. The only action an image affords here is being copied (the pods
 * table carries no image column, so "find pods using this" would filter to
 * nothing), which is the same gesture an IP already has.
 */

/** Enough digest to tell two builds apart; the rest is in the copy. */
const DIGEST_HEX = 12;

function shortDigest(digest: string): string {
  const [algorithm, hex] = digest.split(":");
  if (!hex || hex.length <= DIGEST_HEX) return digest;
  return `${algorithm}:${hex.slice(0, DIGEST_HEX)}…`;
}

export interface ImageRefProps {
  image: string;
  /**
   * The reference sits inside a sentence: it carries the quotation marks the
   * message printed (inside the button, so the copy mark lands outside them)
   * and keeps that mark out of the line until there is something to confirm.
   */
  inline?: boolean;
  className?: string;
}

export function ImageRef({ image, inline, className }: ImageRefProps) {
  const parsed = parseImageRef(image);
  const quote = inline ? <span className="text-fg-fnt">&quot;</span> : null;

  return (
    <CopyableValue
      value={image}
      label={`image ${image}`}
      quietMark={inline}
      className={className}
    >
      {quote}
      {/* A reference this component cannot split is still an image, and still
          worth copying — it just has no structure to show. */}
      {!parsed ? (
        <span className="text-fg">{image}</span>
      ) : (
        <>
          {parsed.registry && (
            <span className="text-fg-fnt">{parsed.registry}/</span>
          )}
          <span className="text-fg">{parsed.repository}</span>
          {parsed.tag && (
            <>
              <span className="text-fg-fnt">:</span>
              <span className="text-fg-mut">{parsed.tag}</span>
            </>
          )}
          {parsed.digest && (
            <span className="text-fg-fnt">@{shortDigest(parsed.digest)}</span>
          )}
        </>
      )}
      {quote}
    </CopyableValue>
  );
}
