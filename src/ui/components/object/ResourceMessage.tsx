import { Fragment, type ReactElement, type ReactNode } from "react";

import { linkifyMessage, type MessageSubject } from "@/lib/message-refs";
import { ImageRef } from "./ImageRef";
import { objectLink } from "@/lib/links";
import { ResourceRef } from "./ResourceRef";

export interface ResourceMessageProps {
  message: string;
  /**
   * The object the message is about. Its namespace places every name the
   * message states without one, and it is never offered as a link to itself.
   */
  subject?: MessageSubject;
  /** For a line that is cut rather than wrapped: nothing in it can break, so nothing is held together. */
  oneLine?: boolean;
}

/** Held on one line where it fits one; longer than the line, it wraps inside itself rather than overflowing. */
const KEPT = "inline-block max-w-full";
const OPENING = /[("'«“[]+$/;
const CLOSING = /^[)"'»”\].,:;!?]+/;
/** A name, a namespace and name, a selector, a ratio: words joined by a mark a browser would break after. */
const JOINED =
  /[("'«“[]*[\p{L}\p{N}]+(?:[-./:=_@]+[\p{L}\p{N}]+)+[)"'»”\].,:;!?]*/gu;

/** Prose whose joined words never break inside, each with the punctuation around it. */
export function Prose({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(JOINED)) {
    if (match.index > at) parts.push(text.slice(at, match.index));
    parts.push(
      <span key={match.index} className={KEPT}>
        {match[0]}
      </span>
    );
    at = match.index + match[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/**
 * A message the cluster wrote, with the objects it names offered rather than
 * printed.
 *
 * `linkifyMessage` decides *what* is named; this decides whether the app can
 * take you there. A kind with no route renders as the text it always was —
 * not as a tinted name with a glyph, which would look like a link that had
 * broken rather than like the sentence it belongs to.
 *
 * The kind is not repeated on the reference: the prose already said "replica
 * set" and the glyph says it again, so a third `ReplicaSet/` in the middle of
 * a sentence is the thing that stops it reading as one.
 */
export function ResourceMessage({
  message,
  subject,
  oneLine = false,
}: ResourceMessageProps) {
  const pieces: Array<string | ReactElement> = [];
  for (const segment of linkifyMessage(message, subject)) {
    const piece =
      segment.kind === "text" ? (
        segment.text
      ) : segment.kind === "image" ? (
        <ImageRef image={segment.ref.reference} inline />
      ) : objectLink(segment.ref) ? (
        <ResourceRef
          kind={segment.ref.kind}
          name={segment.ref.name}
          namespace={segment.ref.namespace}
          showKind={false}
        />
      ) : (
        segment.text
      );
    const last = pieces.length - 1;
    if (typeof piece === "string" && typeof pieces[last] === "string")
      pieces[last] += piece;
    else pieces.push(piece);
  }
  if (pieces.length === 0) return <>{message}</>;

  if (oneLine)
    return (
      <>
        {pieces.map((piece, index) => (
          <Fragment key={index}>{piece}</Fragment>
        ))}
      </>
    );

  // The quote that opens a name and the one that closes it travel with the
  // reference, or a line ends on a lone `"` with the name on the next.
  const text = pieces.map((piece) => (typeof piece === "string" ? piece : ""));
  const open = pieces.map((_, index) =>
    typeof pieces[index] === "string"
      ? ""
      : (OPENING.exec(text[index - 1] ?? "")?.[0] ?? "")
  );
  const close = pieces.map((_, index) =>
    typeof pieces[index] === "string"
      ? ""
      : (CLOSING.exec(text[index + 1] ?? "")?.[0] ?? "")
  );
  return (
    <>
      {pieces.map((piece, index) => {
        if (typeof piece !== "string")
          return (
            <span key={index} className={KEPT}>
              {open[index]}
              {piece}
              {close[index]}
            </span>
          );
        const from = close[index - 1]?.length ?? 0;
        const to = piece.length - (open[index + 1]?.length ?? 0);
        return (
          <Prose key={index} text={piece.slice(from, Math.max(from, to))} />
        );
      })}
    </>
  );
}
