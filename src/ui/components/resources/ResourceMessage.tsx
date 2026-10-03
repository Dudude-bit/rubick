import { Fragment } from "react";

import { linkifyMessage, type MessageSubject } from "@/lib/message-refs";
import { ImageRef } from "./ImageRef";
import { isRoutableKind, ResourceRef } from "./ResourceRef";

export interface ResourceMessageProps {
  message: string;
  /**
   * The object the message is about. Its namespace places every name the
   * message states without one, and it is never offered as a link to itself.
   */
  subject?: MessageSubject;
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
export function ResourceMessage({ message, subject }: ResourceMessageProps) {
  const segments = linkifyMessage(message, subject);
  if (segments.length === 1 && segments[0].kind === "text") {
    return <>{message}</>;
  }
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === "text") {
          return <Fragment key={index}>{segment.text}</Fragment>;
        }
        if (segment.kind === "image") {
          return <ImageRef key={index} image={segment.ref.reference} inline />;
        }
        const { kind, name, namespace } = segment.ref;
        if (!isRoutableKind(kind, namespace)) {
          return <Fragment key={index}>{segment.text}</Fragment>;
        }
        return (
          <ResourceRef
            key={index}
            kind={kind}
            name={name}
            namespace={namespace}
            showKind={false}
          />
        );
      })}
    </>
  );
}
