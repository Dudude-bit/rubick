import { Fragment } from "react";

import { reasonWords } from "@/lib/event-reason";

/** An event's reason whole: a column narrower than it wraps it between its words, and a word wider than the column ends in an ellipsis rather than breaking inside. */
export function ReasonText({ reason }: { reason: string }) {
  return (
    <span className="min-w-0 overflow-hidden text-ellipsis whitespace-normal">
      {reasonWords(reason).map((word, index) => (
        <Fragment key={index}>
          {index > 0 && <wbr />}
          {word}
        </Fragment>
      ))}
    </span>
  );
}
