import { useCallback, type KeyboardEvent } from "react";
import { Search, X } from "lucide-react";
import { parseQueryTerm, termLabel, type QueryTerm } from "./types";

interface LogQueryProps {
  terms: QueryTerm[];
  /** What is being typed. Filters live, and becomes a chip on Enter. */
  draft: string;
  onDraftChange: (draft: string) => void;
  onAddTerm: (term: QueryTerm) => void;
  onRemoveTerm: (term: QueryTerm) => void;
}

/**
 * The query, made of parts you can see and take back.
 *
 * A substring box cannot say what it is doing: `warn` in it means both
 * "lines at warn" and "lines containing the word", and there is nothing on
 * screen afterwards that says which. Each clause here is a chip with its
 * own ×, and the ones that come from clicking a field key in a row are the
 * same objects as the ones you type.
 */
export function LogQuery({
  terms,
  draft,
  onDraftChange,
  onAddTerm,
  onRemoveTerm,
}: LogQueryProps) {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        const term = parseQueryTerm(draft);
        if (!term) return;
        event.preventDefault();
        onAddTerm(term);
        onDraftChange("");
        return;
      }
      // Backspace at an empty caret takes the last chip back, the way every
      // other token field behaves; without it the only way out is the mouse.
      if (event.key === "Backspace" && draft === "" && terms.length > 0) {
        event.preventDefault();
        onRemoveTerm(terms[terms.length - 1]);
      }
    },
    [draft, terms, onAddTerm, onDraftChange, onRemoveTerm]
  );

  return (
    <div className="flex min-w-[11rem] flex-1 flex-wrap items-center gap-1 rounded-md border border-hair px-1.5 py-0.5 focus-within:border-fg-fnt">
      <Search aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-fnt" />
      {terms.map((term) => (
        <Chip key={termLabel(term)} term={term} onRemove={onRemoveTerm} />
      ))}
      <input
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="text, or key=value"
        aria-label="Filter the log"
        className="h-6 min-w-[7rem] flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-fg-fnt"
      />
    </div>
  );
}

function Chip({
  term,
  onRemove,
}: {
  term: QueryTerm;
  onRemove: (term: QueryTerm) => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-sel px-1.5 font-mono text-[11px] leading-[18px] text-fg">
      {term.kind === "text" ? (
        <>
          <span aria-hidden="true" className="text-fg-fnt">
            ⌕
          </span>
          {term.value}
        </>
      ) : (
        <>
          {term.kind === "level" ? "level" : term.key}
          <span className="text-fg-fnt">{term.op}</span>
          {term.value}
        </>
      )}
      <button
        type="button"
        title={`Remove ${termLabel(term)}`}
        onClick={() => onRemove(term)}
        className="text-fg-fnt hover:text-err"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
