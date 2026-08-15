/**
 * One reason your change will not stay, or two, and the two do not read as
 * two warnings.
 *
 * A workload with an autoscaler *and* a delivery controller is ordinary — an
 * HPA committed to git and applied by Argo — and stacking two paragraphs that
 * both begin "X will undo this" is how a dialog teaches somebody to click
 * through it. So the second shape is one sentence with two named causes under
 * it: the reader is told there are two, then which two, in the order they will
 * be felt. Each still says something the other does not — the autoscaler
 * replaces the number, the controller replaces the object and takes the number
 * with it.
 *
 * Drawn here rather than inside one dialog because three surfaces now warn
 * with it — Scale, the delivery intercept, and the YAML editor's apply — and a
 * warning that looked different depending on which control you pressed would
 * undo the point of having one voice.
 */

import { Link } from "react-router-dom";

import type { ActionWarning } from "@/lib/governance";

/** A small count in a sentence is a word. Past three there is no sentence. */
const COUNT_WORD: Record<number, string> = { 2: "Two", 3: "Three" };

export interface ActionWarningsProps {
  warnings: ActionWarning[];
  /**
   * The sentence that heads a stacked pair — "Two things will put this number
   * back." The stacked shape only exists to stop two paragraphs reading as one
   * complaint, so the heading has to name what they are about, and only the
   * caller knows whether that is a replica count or a manifest.
   */
  headingFor?: (count: string) => string;
}

const DEFAULT_HEADING = (count: string) => `${count} things will undo this.`;

export function ActionWarnings({
  warnings,
  headingFor = DEFAULT_HEADING,
}: ActionWarningsProps) {
  if (warnings.length === 0) return null;

  if (warnings.length === 1) {
    const only = warnings[0];
    return (
      // `min-w-0` is load-bearing: `DialogContent` is a CSS grid, and a grid
      // item defaults to `min-width: auto`, so one wide sibling — the apply
      // dialog's diff — stretches the whole column past the panel and takes
      // this sentence off the right of the screen with it.
      <p className="min-w-0 wrap-break-word text-xs text-fg-mut">
        <span className="font-medium text-warn">{only.lead}</span>{" "}
        {only.description}
        {only.to && (
          <>
            {" "}
            <Link to={only.to} className="text-info hover:underline">
              Open what delivers it
            </Link>
            .
          </>
        )}
      </p>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="text-xs font-medium text-warn">
        {headingFor(COUNT_WORD[warnings.length] ?? String(warnings.length))}
      </p>
      {warnings.map((warning) => (
        <p key={warning.key} className="wrap-break-word text-xs text-fg-mut">
          <span className="text-fg">{warning.subject}</span> —{" "}
          {warning.description}
          {warning.to && (
            <>
              {" "}
              <Link to={warning.to} className="text-info hover:underline">
                Open it
              </Link>
              .
            </>
          )}
        </p>
      ))}
    </div>
  );
}
