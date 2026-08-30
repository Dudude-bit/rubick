import { useEffect, useRef, useState } from "react";

export function CopyCommand({ command }: { command: string }) {
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
    <div className="flex items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3">
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-sm whitespace-nowrap text-neutral-200">
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded-md border border-neutral-700 px-2.5 py-1 font-mono text-xs text-neutral-300 transition-colors hover:border-neutral-500 hover:text-white"
      >
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}
