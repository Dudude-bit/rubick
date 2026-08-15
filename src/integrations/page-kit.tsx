/**
 * The chrome three vendor pages draw the same way, and only that.
 *
 * Traefik, Argo CD and Flux answer three unrelated questions, and they all
 * answer them in the same three shapes: a row that is one line until it is
 * asked to open, a finding under it in the controller's own words, and a
 * fixed-order chain drawn left to right with the columns labelled. Those are
 * the app's vocabulary for "ordered by trouble", not any one vendor's, and a
 * third copy of the chevron-and-severity-border markup is how the three pages
 * start disagreeing about what red means.
 *
 * What is deliberately *not* here is anything that decides what a row says.
 * The status word, the findings, the ordering and every sentence in them are
 * each vendor's own, because that is the whole of what the page is for.
 */

import {
  Children,
  cloneElement,
  isValidElement,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ChevronRight, ExternalLink, Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { openExternal } from "@/lib/open-external";
import { cn } from "@/lib/utils";

/** The narrowing box above a list ordered by trouble. */
export function FilterBox({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
}) {
  return (
    <div className="relative w-[260px]">
      <Search
        className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-fnt"
        aria-hidden
      />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="h-7 pl-7 text-xs"
      />
    </div>
  );
}

/** How a row reads at a glance. Anything not `ok` is a reason to open it. */
export type Tone = "ok" | "warn" | "err";

const toneText = (tone: Tone) =>
  tone === "err" ? "text-err" : tone === "warn" ? "text-warn" : "text-ok";

/**
 * A row in a list ordered by trouble.
 *
 * The reader's decision wins once they have made one; until then the row
 * follows the data, so a row that opened itself because it was broken does
 * not close itself when a slower query answers.
 *
 * `brief` survives the row being closed: collapsing hides the detail, never
 * the problem.
 */
export function TroubleRow({
  title,
  meta,
  state,
  openByDefault = false,
  brief,
  children,
  last,
}: {
  title: ReactNode;
  meta?: ReactNode;
  state: { text: string; tone: Tone };
  openByDefault?: boolean;
  brief?: ReactNode;
  children: ReactNode;
  last?: boolean;
}) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? openByDefault;

  return (
    <div className={cn("py-2", !last && "border-b border-hair")}>
      <button
        type="button"
        onClick={() => setChosen(!open)}
        aria-expanded={open}
        className="flex w-full items-baseline gap-2 text-left"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 flex-none translate-y-0.5 text-fg-fnt transition-transform",
            open && "rotate-90"
          )}
        />
        <span className="truncate font-mono text-[12.5px] text-fg">
          {title}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-fg-fnt">
          {meta}
        </span>
        <span className={cn("flex-none text-[11px]", toneText(state.tone))}>
          {state.text}
        </span>
      </button>

      {open ? (
        <div className="ml-5 mt-2 flex flex-col gap-3">{children}</div>
      ) : (
        brief != null && <div className="ml-5 mt-1.5">{brief}</div>
      )}
    </div>
  );
}

/**
 * A finding: what is wrong, in one line, with the reason under it.
 *
 * `verbatim` is the controller's own message and is drawn as written — never
 * paraphrased, never truncated to a tidy width. A rewritten error is a second
 * guess at somebody else's failure, and the string is what the reader will
 * paste into a search.
 */
export function Finding({
  tone,
  title,
  verbatim,
  children,
}: {
  tone: Exclude<Tone, "ok">;
  title: ReactNode;
  verbatim?: string | null;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "border-l-2 pl-2.5",
        tone === "err" ? "border-err" : "border-warn"
      )}
    >
      <p className={cn("text-[11.5px]", toneText(tone))}>{title}</p>
      {verbatim && (
        <p className="mt-0.5 select-text wrap-break-word font-mono text-[11px] text-fg-mut">
          {verbatim}
        </p>
      )}
      {children != null && (
        <div className="mt-0.5 text-[11.5px] text-fg-mut">{children}</div>
      )}
    </div>
  );
}

/**
 * A way out of the app, for the one kind of destination this tree has:
 * somebody else's website.
 *
 * A real anchor with the real address, so the webview's context menu can copy
 * it and a screen reader announces a link — and every gesture intercepted,
 * because following it would navigate the app away from itself.
 *
 * Callers hand it a URL that is already known to be mechanical. Nothing here
 * decides whether a link should exist; `gitRepoLink` and its neighbours do
 * that, and a destination they declined never reaches this component.
 */
export function OutLink({
  href,
  site,
  children,
  className,
}: {
  href: string;
  site: string;
  children: ReactNode;
  className?: string;
}) {
  const go = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void openExternal(href, site);
  };

  return (
    <a
      href={href}
      onClick={go}
      onAuxClick={(event) => event.button === 1 && go(event)}
      title={`Open on ${site}`}
      className={cn(
        "inline-flex items-baseline gap-0.5 text-info hover:underline",
        className
      )}
    >
      {children}
      <ExternalLink className="size-2.5 self-center" aria-hidden />
    </a>
  );
}

/** One box in a chain, with its second line of detail. */
export function Cell({
  children,
  bad,
  warn,
  under,
}: {
  children: ReactNode;
  bad?: boolean;
  /** A state that is neither healthy nor a failure — a draining endpoint is
   *  the case this exists for, and colouring it red would be the page
   *  calling a rolling restart an outage. */
  warn?: boolean;
  under?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-[4px] border border-hair bg-hover px-2 py-1 font-mono text-[11px] text-fg-mid",
        warn && "border-warn/50 text-warn",
        bad && "border-err/50 text-err"
      )}
    >
      <span className="block truncate">{children}</span>
      {under != null && (
        <span className="mt-0.5 block truncate font-sans text-[10px] text-fg-fnt">
          {under}
        </span>
      )}
    </div>
  );
}

/**
 * A chain: labelled columns in the order a request crosses them.
 *
 * The columns used to be a bare `grid grid-cols-5` at each call site and the
 * boxes sat in five unconnected stacks — a table of cells that the reader had
 * to be told was a sequence. The join is what makes it read as one path, and
 * it is drawn here so all five chains in the app agree about it rather than
 * each page inventing its own.
 */
export function Chain({ children }: { children: ReactNode }) {
  const columns = Children.toArray(children);
  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`,
      }}
    >
      {columns.map((column, index) =>
        isValidElement<{ linked?: boolean }>(column)
          ? cloneElement(column, { linked: index > 0 })
          : column
      )}
    </div>
  );
}

/** One labelled column of a chain. */
export function Column({
  label,
  linked,
  children,
}: {
  label: string;
  /** Set by {@link Chain} on every column after the first. */
  linked?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col pr-3">
      <span className="mb-1.5 text-[9.5px] uppercase tracking-[0.08em] text-fg-fnt">
        {label}
      </span>
      <div className="relative flex flex-col gap-1.5">
        {/* Decorative: the columns are labelled and ordered, so the join says
            nothing a screen reader is not already told. */}
        {linked && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -left-3 top-[9px] flex w-3 items-center"
          >
            <span className="h-px flex-1 bg-hair" />
            <ChevronRight className="ml-[-3px] size-2.5 flex-none text-fg-fnt" />
          </span>
        )}
        {children}
      </div>
    </div>
  );
}
