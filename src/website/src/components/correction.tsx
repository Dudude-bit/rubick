const COMMIT = "https://github.com/Dudude-bit/rubick/commit/713a2ad";

export function Correction() {
  return (
    <details className="group mt-4 rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-3 open:bg-neutral-900/60">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 font-mono text-sm text-neutral-400 marker:hidden hover:text-neutral-200">
        <span className="size-1.5 rounded-full bg-amber-400" />
        We got this one wrong too
        <span
          aria-hidden
          className="ml-auto text-neutral-500 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
        >
          ›
        </span>
      </summary>
      <div className="mt-3 flex flex-col gap-2 text-sm text-neutral-400">
        <p>
          The Pods list has derived kubectl's status since 3.0.0. Three of
          Rubick's own readers still used .status.phase where that status was
          meant: the port-forward picker, the infrastructure builder and the
          peek panel's disabled-action sentence. A reviewer saw a crash-looping
          pod drawn as Running there.
        </p>
        <p>
          Fixed in{" "}
          <a
            href={COMMIT}
            className="font-mono text-neutral-200 underline decoration-neutral-700 underline-offset-4 transition-colors hover:text-white"
          >
            713a2ad
          </a>
          , with a corpus of pod shapes both the Rust and the TypeScript
          evaluator must now agree on. If you find the fourth reader, that is
          worth an issue.
        </p>
      </div>
    </details>
  );
}
