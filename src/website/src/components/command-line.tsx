import { useEffect, useRef, useState } from "react";

export function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  function copy() {
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="flex items-start gap-3">
      <span className="text-accent font-mono text-sm leading-6 select-none">
        $
      </span>
      <code className="min-w-0 flex-1 font-mono text-sm leading-6 break-all whitespace-pre-wrap text-neutral-100">
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy command"
        className="-my-1 grid shrink-0 rounded-md border border-neutral-700 px-2.5 py-1.5 font-mono text-xs text-neutral-300 transition-[border-color,color,transform] duration-150 hover:border-neutral-500 hover:text-white active:scale-[0.96]"
      >
        <span
          aria-hidden
          className={`[grid-area:1/1] transition-opacity duration-150 ${copied ? "opacity-0" : "opacity-100"}`}
        >
          copy
        </span>
        <span
          aria-hidden
          className={`[grid-area:1/1] text-green-300 transition-opacity duration-150 ${copied ? "opacity-100" : "opacity-0"}`}
        >
          copied
        </span>
        <span className="sr-only" aria-live="polite">
          {copied ? "Copied" : ""}
        </span>
      </button>
    </div>
  );
}
