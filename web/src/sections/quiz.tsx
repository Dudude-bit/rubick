import { useRef, useState } from "react";
import { QUIZ_CASES, type QuizContainer } from "./quiz-cases";
import { Reveal } from "../components/motion/reveal";
import { Section } from "../components/section";
import { useHydrated } from "../lib/use-hydrated";

const VERDICTS = [...new Set([...QUIZ_CASES.map((c) => c.expect), "Running"])];
const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent";

function evidence(containers: QuizContainer[]) {
  for (const [index, container] of containers.entries()) {
    const { waiting, terminated } = container.state;
    if (waiting?.reason) {
      return {
        index,
        field: "reason",
        reason: `containerStatuses[${index}].state.waiting.reason is ${waiting.reason}; the first container verdict replaces the phase.`,
      };
    }
    if (terminated) {
      const field = terminated.reason
        ? "reason"
        : terminated.signal
          ? "signal"
          : "exitCode";
      return {
        index,
        field,
        reason: `The container terminated${terminated.reason ? ` with reason ${terminated.reason}` : ` without a reason; ${field} is ${terminated[field] ?? 0}`}.`,
      };
    }
  }
  return {
    index: null,
    field: "phase",
    reason: "No waiting reason or termination replaces the reported phase.",
  };
}

export function Quiz() {
  const interactive = useHydrated();
  const [index, setIndex] = useState(0);
  const [choice, setChoice] = useState<string | null>(null);
  const firstVerdict = useRef<HTMLButtonElement>(null);
  const current = QUIZ_CASES[index]!;
  const inspected = !interactive || choice !== null;
  const decisive = evidence(current.status.containerStatuses);

  function nextCase() {
    setIndex((previous) => (previous + 1) % QUIZ_CASES.length);
    setChoice(null);
    firstVerdict.current?.focus();
  }

  return (
    <Section id="quiz" eyebrow="Try it yourself">
      <Reveal>
        <h2 className="max-w-3xl font-display text-3xl font-bold tracking-tight md:text-5xl">
          Would you call this Running?
        </h2>
        <p className="mt-6 max-w-2xl text-neutral-400">
          Start with the reported phase. Read the container states. Pick the
          status you expect inspection to leave standing.
        </p>
      </Reveal>
      <Reveal className="mt-12 overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/60">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-neutral-800 p-6">
          <p className="font-mono text-sm text-neutral-300">
            Pod status fragment
          </p>
          <p
            aria-live="polite"
            aria-atomic="true"
            className="font-mono text-sm tabular-nums text-neutral-400"
          >
            {index + 1} of {QUIZ_CASES.length}
          </p>
        </div>
        <div className="p-6">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-xs text-neutral-400">
              reported phase
            </span>
            <span
              data-decisive={
                inspected && decisive.field === "phase" ? "" : undefined
              }
              className={`quiz-field rounded-md border px-2.5 py-1 font-mono text-sm ${current.status.phase === "Running" ? "border-green-400/60 text-green-300" : "border-red-400/60 text-red-300"}`}
            >
              {current.status.phase}
            </span>
          </div>
          <div className="mt-6 space-y-4">
            {current.status.containerStatuses.map((raw, containerIndex) => {
              const container: QuizContainer = raw;
              const state = container.state;
              const fields = [
                [
                  "state",
                  state.waiting
                    ? "waiting"
                    : state.terminated
                      ? "terminated"
                      : state.running
                        ? "running"
                        : "not reported",
                ],
                ["reason", state.waiting?.reason ?? state.terminated?.reason],
                ["exitCode", state.terminated?.exitCode],
                ["signal", state.terminated?.signal],
                ["ready", container.ready],
              ] as const;
              return (
                <div
                  key={containerIndex}
                  className="min-w-0 rounded-lg border border-neutral-800 p-4 font-mono text-xs"
                >
                  <p className="break-all text-neutral-400">
                    containerStatuses[{containerIndex}]
                  </p>
                  <dl className="mt-3 flex flex-wrap gap-2">
                    {fields.map(([field, value]) => (
                      <div
                        key={field}
                        data-decisive={
                          inspected &&
                          decisive.index === containerIndex &&
                          decisive.field === field
                            ? ""
                            : undefined
                        }
                        className="quiz-field min-w-0 rounded-md border border-transparent px-2 py-1"
                      >
                        <dt className="text-neutral-400">{field}</dt>
                        <dd className="mt-1 break-all text-neutral-200">
                          {value === undefined ? "not reported" : String(value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              );
            })}
          </div>
          {interactive ? (
            <fieldset className="mt-6">
              <legend className="text-sm text-neutral-400">
                Pick a verdict to inspect
              </legend>
              <div className="mt-3 flex flex-wrap gap-2">
                {VERDICTS.map((verdict, verdictIndex) => (
                  <button
                    key={verdict}
                    ref={verdictIndex === 0 ? firstVerdict : undefined}
                    type="button"
                    aria-pressed={choice === verdict}
                    aria-disabled={choice !== null}
                    onClick={() => {
                      if (choice === null) setChoice(verdict);
                    }}
                    className={`min-h-11 max-w-full break-all rounded-md border px-3 py-2 font-mono text-xs ${FOCUS} ${choice === verdict ? "border-neutral-300 bg-neutral-800 text-neutral-100" : "border-neutral-700 text-neutral-300 enabled:hover:border-neutral-400"}`}
                  >
                    {verdict}
                  </button>
                ))}
              </div>
            </fieldset>
          ) : null}
          <div aria-live="polite" aria-atomic="true" className="mt-6">
            {inspected ? (
              <div
                key={index}
                className="quiz-answer border-t border-neutral-800 pt-6"
              >
                <p className="text-xs text-neutral-400">After inspection</p>
                <span
                  className={`mt-2 inline-block rounded-md border px-2.5 py-1 font-mono text-sm ${current.expect === "Running" ? "border-green-400/60 text-green-300" : "border-red-400/60 text-red-300"}`}
                >
                  {current.expect}
                </span>
                <p className="mt-3 max-w-2xl text-sm text-neutral-300">
                  {decisive.reason}
                </p>
                {choice !== null ? (
                  <p className="mt-3 text-sm text-neutral-400">
                    You said{" "}
                    <span className="font-mono text-neutral-200">{choice}</span>
                    .
                    {choice === current.expect
                      ? " That matches this case."
                      : " This case gives a different answer."}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
          {interactive ? (
            <button
              type="button"
              onClick={nextCase}
              className={`mt-6 min-h-11 rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-200 hover:border-neutral-400 ${FOCUS}`}
            >
              Next case <span aria-hidden="true">→</span>
            </button>
          ) : null}
        </div>
      </Reveal>
      <p className="mt-6 max-w-3xl text-sm text-neutral-400">
        Six shapes the Rust and TypeScript evaluators must agree on, not proof
        of universal agreement with kubectl.
      </p>
    </Section>
  );
}
