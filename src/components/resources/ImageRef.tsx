import type { MouseEvent } from "react";
import { ExternalLink } from "lucide-react";
import { CopyableValue } from "@/components/ui/copyable-value";
import { openExternal } from "@/lib/open-external";
import {
  parseImageRef,
  registryLink,
  type RegistryLink,
} from "@/lib/image-ref";
import { cn } from "@/lib/utils";

/**
 * A container image reference, split the way a resource name is: the part a
 * reader recognises at full strength, its context quieter.
 *
 * The repository is what identifies the image — `busybox`, `project/sub/app`.
 * The registry that hosts it and the tag that versions it are context, so they
 * drop a step. What an image affords is being copied — the same gesture an IP
 * already has, since the pods table carries no image column and "find pods
 * using this" would filter to nothing — and, where the registry has a page for
 * it, being read there. Which registries those are is `registryLink`'s
 * judgement; the ones it declines get no mark at all.
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

  const value = (
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

  const link = registryLink(parsed);
  if (!link) return value;

  // One `group` over both marks, so hovering either the reference or the
  // registry link raises the pair — they are two ways to act on one image, not
  // two neighbouring controls.
  return (
    <span className="group inline-flex min-w-0 items-center">
      {value}
      <RegistryLinkMark link={link} quiet={inline} />
    </span>
  );
}

/**
 * The way out to the registry's own page.
 *
 * A real `<a href>`, because the destination is real: the webview's context
 * menu can copy it, a screen reader announces a link, and the address is the
 * one the reader would have got anyway. Every gesture on it is intercepted all
 * the same — the webview has no second window to hand a page to, so letting one
 * through would navigate the app away from itself — and each of them means the
 * one thing this control does: give the URL to the system browser.
 *
 * It follows the copy mark's rule rather than inventing one. In a row it
 * reserves its width and fades in with the copy mark on hover; inside a
 * sentence it takes no width at rest, because `quietMark`'s promise is that
 * nothing sits in the prose until the reader asks. The copy mark can wait for
 * its confirmation to appear; an action has no confirmation, so hovering the
 * reference is the moment it has.
 */
function RegistryLinkMark({
  link,
  quiet,
}: {
  link: RegistryLink;
  quiet?: boolean;
}) {
  const label = `Open ${link.name} on ${link.site}`;

  const go = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    // The row underneath usually navigates, and a click that both leaves for
    // the browser and opens a detail page is a click nobody meant to make.
    event.stopPropagation();
    void openExternal(link.url, link.site);
  };

  return (
    <a
      href={link.url}
      onClick={go}
      onAuxClick={(event) => event.button === 1 && go(event)}
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex flex-none items-center justify-center overflow-hidden rounded-sm",
        "text-fg-fnt transition-[opacity,width] hover:text-info",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-info",
        "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
        // Zero width rather than `hidden`, which would drop it out of the tab
        // order and leave the sentence's link unreachable without a mouse.
        quiet ? "w-0 group-hover:w-4 focus-visible:w-4" : "w-4"
      )}
    >
      <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
    </a>
  );
}
