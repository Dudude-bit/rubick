import { Fragment } from "react";

import { reasonWords } from "@/lib/event-reason";

/** An event's reason whole: a column narrower than it wraps it between its words instead of cutting it. */
export function ReasonText({ reason }: { reason: string }) {
  return (
    <span className="min-w-0 whitespace-normal wrap-break-word">
      {reasonWords(reason).map((word, index) => (
        <Fragment key={index}>
          {index > 0 && <wbr />}
          {word}
        </Fragment>
      ))}
    </span>
  );
}
