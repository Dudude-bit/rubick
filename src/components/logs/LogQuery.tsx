import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronRight, Search, X } from "lucide-react";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";

import {
  fieldSuggestions,
  MAX_TRACKED_VALUES,
  type FieldIndex,
  type FieldSuggestion,
} from "./hooks/log-buffer";
import {
  fieldTerm,
  formatCount,
  formatTimeRange,
  parseQueryTerm,
  termLabel,
  type QueryTerm,
} from "./types";

/**
 * Values offered for one key. Past this the list stops being a list and
 * starts being the log again; what is left is reachable by typing, which
 * filters this same set.
 */
const MAX_LISTED_VALUES = 12;

const NO_SUGGESTIONS: FieldSuggestion[] = [];

/** A key to narrow to, or a finished `key=value` to add. */
type Option =
  | { kind: "key"; key: string; lines: number }
  | { kind: "value"; key: string; value: string; lines: number };

interface LogQueryProps {
  terms: QueryTerm[];
  /** What is being typed. Filters live, and becomes a chip on Enter. */
  draft: string;
  onDraftChange: (draft: string) => void;
  onAddTerm: (term: QueryTerm) => void;
  onRemoveTerm: (term: QueryTerm) => void;
  /** Counted as the buffer filled — see `FieldIndex`. */
  fields: FieldIndex;
}

/**
 * The query, made of parts you can see and take back.
 *
 * A substring box cannot say what it is doing: `warn` in it means both
 * "lines at warn" and "lines containing the word", and there is nothing on
 * screen afterwards that says which. Each clause here is a chip with its
 * own ×, and the ones that come from clicking a field key in a row are the
 * same objects as the ones you type — `fieldTerm` builds all of them.
 *
 * Focusing it opens what the buffer can actually be filtered by. Parsing
 * fields is only worth its cost if the keys can be found, and until now
 * the only way to find one was to spot it in a row and click it: a query
 * language whose vocabulary is discovered by luck. Two steps, key then
 * value, because `component=ingest` is the useful filter and
 * `component exists` almost never is.
 */
export function LogQuery({
  terms,
  draft,
  onDraftChange,
  onAddTerm,
  onRemoveTerm,
  fields,
}: LogQueryProps) {
  const [open, setOpen] = useState(false);
  /** The key whose values are being offered; null while offering keys. */
  const [activeKey, setActiveKey] = useState<string | null>(null);
  /** Highlighted option. -1 means none, which is what keeps Enter plain. */
  const [cursor, setCursor] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  // Only while it is on screen: this sorts every tracked value, and the
  // index behind it changes with every batch.
  const suggestions = useMemo(
    () => (open ? fieldSuggestions(fields) : NO_SUGGESTIONS),
    [open, fields]
  );

  const active = useMemo(
    () =>
      activeKey === null
        ? null
        : (suggestions.find((entry) => entry.key === activeKey) ?? null),
    [activeKey, suggestions]
  );

  const options = useMemo<Option[]>(() => {
    const needle = draft.trim().toLowerCase();
    if (active === null) {
      return suggestions
        .filter((entry) => entry.key.toLowerCase().includes(needle))
        .map(
          (entry): Option => ({
            kind: "key",
            key: entry.key,
            lines: entry.lines,
          })
        );
    }
    return active.values
      .filter((entry) => entry.value.toLowerCase().includes(needle))
      .slice(0, MAX_LISTED_VALUES)
      .map(
        (entry): Option => ({
          kind: "value",
          key: active.key,
          value: entry.value,
          lines: entry.lines,
        })
      );
  }, [active, suggestions, draft]);

  // A cursor left pointing past a list the arriving batch shortened is not
  // an option, so Enter falls back to committing what was typed.
  const at = cursor < options.length ? cursor : -1;

  // Arrowing past the fold has to bring the option with it — the input
  // keeps the focus, so the browser will not do it. Optional call because
  // jsdom does not implement it.
  useEffect(() => {
    if (at < 0) return;
    document
      .getElementById(`${listId}-${at}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [at, listId]);

  const close = useCallback(() => {
    setOpen(false);
    setActiveKey(null);
    setCursor(-1);
  }, []);

  const apply = useCallback(
    (option: Option) => {
      if (option.kind === "key") {
        setActiveKey(option.key);
      } else {
        onAddTerm(fieldTerm(option.key, option.value));
        setActiveKey(null);
      }
      onDraftChange("");
      setCursor(-1);
      inputRef.current?.focus();
    },
    [onAddTerm, onDraftChange]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        if (options.length === 0) return;
        const step = event.key === "ArrowDown" ? 1 : -1;
        const next = at + step;
        setCursor(next < 0 ? options.length - 1 : next % options.length);
        return;
      }

      if (event.key === "Escape") {
        if (!open) return;
        event.preventDefault();
        close();
        return;
      }

      if (event.key === "Enter") {
        if (open && at >= 0) {
          event.preventDefault();
          apply(options[at]);
          return;
        }
        // A key was chosen and a value typed under it: that is `key=value`,
        // including a value the buffer has not seen — which is the whole
        // way in for a key with too many values to have been listed.
        const typed = draft.trim();
        if (active && typed !== "") {
          event.preventDefault();
          onAddTerm(fieldTerm(active.key, typed));
          onDraftChange("");
          setActiveKey(null);
          return;
        }
        const term = parseQueryTerm(draft);
        if (!term) return;
        event.preventDefault();
        onAddTerm(term);
        onDraftChange("");
        return;
      }

      // Backspace at an empty caret takes the last chip back, the way every
      // other token field behaves; without it the only way out is the mouse.
      // Inside a key it steps back out of that key first — the same "undo
      // the last thing I picked", one level up.
      if (event.key === "Backspace" && draft === "") {
        if (active) {
          event.preventDefault();
          setActiveKey(null);
          setCursor(-1);
          return;
        }
        if (terms.length > 0) {
          event.preventDefault();
          onRemoveTerm(terms[terms.length - 1]);
        }
      }
    },
    [
      active,
      apply,
      at,
      close,
      draft,
      onAddTerm,
      onDraftChange,
      onRemoveTerm,
      open,
      options,
      terms,
    ]
  );

  return (
    <Popover open={open} onOpenChange={(next) => !next && close()}>
      <PopoverAnchor asChild>
        {/* Exactly 24px including the border, and it stays there: the
            chips scroll sideways rather than wrapping, because a second
            row of them would push every other control in the toolbar out
            of line. Nothing is lost by it — a chip out of view is one
            Backspace or one scroll away, and the query is also written
            out in the status bar. */}
        <div
          ref={boxRef}
          className="flex h-6 min-w-[11rem] flex-1 items-center gap-1 overflow-x-auto rounded-md border border-hair px-1.5 [scrollbar-width:none] focus-within:border-fg-fnt [&::-webkit-scrollbar]:hidden"
        >
          <Search
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-fg-fnt"
          />
          {terms.map((term) => (
            <Chip key={termLabel(term)} term={term} onRemove={onRemoveTerm} />
          ))}
          {/* The chosen key, standing where a chip would, so the input is
              never asking for a value without saying whose. */}
          {active && (
            <span className="shrink-0 font-mono text-[11px] text-fg-mut">
              {active.key}
              <span className="text-fg-fnt">=</span>
            </span>
          )}
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => {
              onDraftChange(event.target.value);
              setCursor(-1);
            }}
            onKeyDown={handleKeyDown}
            onFocus={() => setOpen(true)}
            onBlur={close}
            placeholder={
              active ? `value of ${active.key}` : "text, or key=value"
            }
            aria-label="Filter the log"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={at >= 0 ? `${listId}-${at}` : undefined}
            className="h-[22px] min-w-[7rem] flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-fg-fnt"
          />
        </div>
      </PopoverAnchor>

      <PopoverContent
        // The reader is typing. Nothing here may take the caret: the
        // options are reached with the arrows and named by
        // aria-activedescendant, and a pointer press on the surface is
        // swallowed before it can blur the input.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onMouseDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (boxRef.current?.contains(event.target as Node)) {
            event.preventDefault();
          }
        }}
        className="w-72 p-1"
      >
        {active && (
          <div className="flex items-center gap-1 px-1 pb-1 text-[11px] text-fg-fnt">
            <button
              type="button"
              // Not a tab stop: focus stays in the input throughout, and
              // Backspace on an empty caret does exactly this.
              tabIndex={-1}
              title="Back to all fields (backspace)"
              onClick={() => {
                setActiveKey(null);
                setCursor(-1);
              }}
              className="rounded px-1 hover:bg-hover hover:text-fg-mut"
            >
              All fields
            </button>
            <ChevronRight aria-hidden="true" className="h-3 w-3" />
            <span className="font-mono text-fg-mut">{active.key}</span>
          </div>
        )}

        <div
          id={listId}
          role="listbox"
          aria-label={
            active ? `Values of ${active.key}` : "Fields in the buffered log"
          }
          className="max-h-56 overflow-y-auto scrollbar-thin"
        >
          {options.map((option, index) => (
            <OptionRow
              key={option.kind === "key" ? option.key : option.value}
              id={`${listId}-${index}`}
              selected={index === at}
              lines={option.lines}
              onHover={() => setCursor(index)}
              onPick={() => apply(option)}
            >
              {option.kind === "key" ? option.key : option.value}
            </OptionRow>
          ))}
        </div>

        <Hint
          active={active}
          suggestions={suggestions}
          options={options.length}
          draft={draft.trim()}
        />
      </PopoverContent>
    </Popover>
  );
}

function OptionRow({
  id,
  selected,
  lines,
  onHover,
  onPick,
  children,
}: {
  id: string;
  selected: boolean;
  lines: number;
  onHover: () => void;
  onPick: () => void;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      onMouseEnter={onHover}
      onClick={onPick}
      className={`flex cursor-pointer items-baseline gap-2 rounded px-1.5 py-[3px] text-xs ${
        selected ? "bg-hover text-fg" : "text-fg-mid"
      }`}
    >
      <span className="min-w-0 flex-1 truncate font-mono">{children}</span>
      {/* Spelled out rather than left as a bare number: the count is the
          reason to pick one of these over another, and a screen reader
          reads the option's text. */}
      <span className="shrink-0 tabular-nums text-[11px] text-fg-fnt">
        {formatCount(lines)} {lines === 1 ? "line" : "lines"}
      </span>
    </div>
  );
}

/**
 * Why the list is short, or empty. A popover that opens on nothing and
 * says nothing reads as broken, and "this pod prints plain text" is a
 * real answer to "what can I filter on".
 */
function Hint({
  active,
  suggestions,
  options,
  draft,
}: {
  active: FieldSuggestion | null;
  suggestions: FieldSuggestion[];
  options: number;
  draft: string;
}) {
  let text: ReactNode = null;

  if (active?.wide) {
    text = (
      <>
        <span className="font-mono">{active.key}</span> carries over{" "}
        {MAX_TRACKED_VALUES} distinct values — too many to list. Type the one
        you are after and press enter.
      </>
    );
  } else if (options === 0) {
    text = active
      ? `No value of ${active.key} matches “${draft}”.`
      : draft === ""
        ? "Nothing buffered yet. The fields appear as lines arrive."
        : `No field matches “${draft}”. Enter searches the text instead.`;
  } else if (active && active.values.length > options) {
    text = `Showing the ${options} most common. Type to narrow.`;
  } else if (!active && suggestions.length > 0 && suggestions.length <= 2) {
    // Only the two synthetic keys: the parser read nothing out of these
    // lines, which is a fact about the pod rather than a failure here.
    text = "These lines carry no structured fields — only level and container.";
  }

  if (text === null) return null;
  return (
    <p className="border-t border-hair px-1.5 pb-0.5 pt-1.5 text-[11px] leading-snug text-fg-fnt">
      {text}
    </p>
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
    <span className="inline-flex shrink-0 items-center gap-1 rounded bg-sel px-1.5 font-mono text-[11px] leading-[18px] text-fg">
      {term.kind === "text" ? (
        <>
          <span aria-hidden="true" className="text-fg-fnt">
            ⌕
          </span>
          {term.value}
        </>
      ) : term.kind === "time" ? (
        <>
          time<span className="text-fg-fnt">=</span>
          {formatTimeRange(term.from, term.to)}
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
