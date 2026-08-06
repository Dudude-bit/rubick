import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import {
  advanceDensity,
  axisLabel,
  INITIAL_CURSOR,
  MIN_USEFUL_SLICES,
  sliceClock,
  stepLabel,
  type Density,
  type DensityBucket,
  type DensityCursor,
} from "./density";
import { formatCount, formatSpan, type StreamedLogLine } from "./types";

/**
 * The strip: the retained buffer as a map you can click.
 *
 * A log pane answers "watch it happen" by scrolling. It answers "what
 * broke" and "find the burst four minutes ago" only if there is something
 * on screen that shows the shape of the whole buffer at once, and that is
 * this. Height is volume, the worst level in a slice stacks on top in its
 * own colour, the slice the reader is looking at is marked, clicking a
 * slice scrolls there and dragging across bounds the query by time.
 *
 * The two-way tie to the viewport is the part that makes it a map. A bar
 * chart above a log is decoration; a bar chart that says where you are
 * and takes you somewhere is navigation.
 */

/** Bar area. Tall enough for a burst to read, short enough not to be a chart. */
const TRACK_PX = 30;
/** The row above the bars carrying the error mark. Shape, not colour. */
const MARK_PX = 4;
/** The row above that carrying the viewport ruler. */
const RULER_PX = 3;

/** A slice that saw anything is never drawn as nothing. */
const MIN_BAR_PX = 2;
/** Nor is one error inside two thousand lines drawn as no errors. */
const MIN_LEVEL_PX = 3;

/**
 * How wide a bar wants to be. The slice budget follows the measured
 * width from this, so the same pod is coarser in a 360px peek panel than
 * in a full window rather than being sliced into hairlines.
 */
const TARGET_BAR_PX = 7;
const MIN_BUDGET = 24;
const MAX_BUDGET = 160;
/** Before the first measurement. Roughly a 700px pane. */
const DEFAULT_BUDGET = 96;

/** Bursts spelled out for a screen reader; past this it is a list, not a summary. */
const SPOKEN_BURSTS = 5;

interface LogDensityStripProps {
  /**
   * The buffer as the query left it, minus the time range itself.
   *
   * Including the time range here would eat the map: dragging out four
   * minutes would leave a strip of exactly those four minutes, with
   * nowhere to drag back to. The strip therefore shows everything the
   * other terms allow and draws the time range on top of it as a band.
   */
  logs: StreamedLogLine[];
  /** Identity of that filtering. A different query is a different strip. */
  scope: string;
  /** Lines held in total, to tell "nothing yet" from "nothing matches". */
  retained: number;
  /** The cap has evicted: the left edge is not the start of the log. */
  headDropped: boolean;
  /**
   * Intake is set, so the buffer this maps is not everything the
   * container wrote. A map that quietly stops being a map is the one
   * thing this exists to avoid, so the header says so.
   */
  intake: boolean;
  /** The committed range, so the strip draws what the chip says. */
  selection: { from: number; to: number } | null;
  /** The stretch of clock the list is showing, in ms since epoch. */
  viewportFrom: number;
  viewportTo: number;
  onJump: (epoch: number) => void;
  onSelect: (from: number, to: number) => void;
  onClearSelection: () => void;
}

export function LogDensityStrip({
  logs,
  scope,
  retained,
  headDropped,
  intake,
  selection,
  viewportFrom,
  viewportTo,
  onJump,
  onSelect,
  onClearSelection,
}: LogDensityStripProps) {
  const id = useId();
  const barsRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);

  useEffect(() => {
    const el = barsRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  // Quantised so that nudging a split pane by a pixel does not keep
  // re-picking the rung and rebuilding the histogram under the reader.
  const budget = useMemo(() => {
    if (width === 0) return DEFAULT_BUDGET;
    const wanted = Math.round(width / TARGET_BAR_PX / 8) * 8;
    return Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, wanted));
  }, [width]);

  // The accumulator has to survive renders and be advanced during one,
  // which is what the rule below is there to prevent. It is safe here for
  // two specific reasons: `advanceDensity` is idempotent — running it
  // twice on the same buffer finds its own tail and counts nothing — so
  // a double render cannot double-count, and every input it reads is a
  // dependency of this memo, so the render can never be stale. Moving it
  // to an effect would cost a second render pass four times a second, on
  // the one component that is redrawing anyway.
  const cursorRef = useRef<DensityCursor>({ ...INITIAL_CURSOR });
  const density = useMemo(
    // eslint-disable-next-line react-hooks/refs
    () => advanceDensity(cursorRef.current, logs, budget, scope),
    [logs, budget, scope]
  );

  const { buckets, step } = density;
  const count = buckets.length;
  const origin = count > 0 ? buckets[0].start : 0;
  const indexOf = useCallback(
    (epoch: number) =>
      count === 0
        ? 0
        : Math.min(count - 1, Math.max(0, Math.floor((epoch - origin) / step))),
    [count, origin, step]
  );

  const active = Math.min(cursor, Math.max(0, count - 1));

  // What is drawn as chosen: the drag while it is happening, the chip's
  // range once it has been let go.
  const chosen = useMemo(() => {
    if (drag) {
      return {
        lo: Math.min(drag.from, drag.to),
        hi: Math.max(drag.from, drag.to),
      };
    }
    if (!selection || count === 0) return null;
    return { lo: indexOf(selection.from), hi: indexOf(selection.to) };
  }, [drag, selection, count, indexOf]);

  const inView = useMemo(() => {
    if (count === 0 || viewportTo <= 0) return null;
    return { lo: indexOf(viewportFrom), hi: indexOf(viewportTo) };
  }, [count, viewportFrom, viewportTo, indexOf]);

  // Indices are clamped on the way out because the strip is not standing
  // still while it is being used: a batch landing mid-drag can drop slices
  // off the head, and the index the pointer went down on is then one past
  // the end.
  const clamp = useCallback(
    (index: number) => Math.min(count - 1, Math.max(0, index)),
    [count]
  );

  const commit = useCallback(
    (lo: number, hi: number) => {
      if (count === 0) return;
      onSelect(buckets[clamp(lo)].start, buckets[clamp(hi)].start + step - 1);
    },
    [buckets, count, step, clamp, onSelect]
  );

  const sliceAt = useCallback((clientX: number, total: number) => {
    const el = barsRef.current;
    if (!el || total === 0) return 0;
    const rect = el.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    return Math.min(total - 1, Math.max(0, Math.floor(ratio * total)));
  }, []);

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || count === 0) return;
      const index = sliceAt(event.clientX, count);
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrag({ from: index, to: index });
      setCursor(index);
      setAnchor(null);
    },
    [count, sliceAt]
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!drag) return;
      const index = sliceAt(event.clientX, count);
      if (index !== drag.to) setDrag({ from: drag.from, to: index });
      setCursor(index);
    },
    [drag, count, sliceAt]
  );

  const handlePointerUp = useCallback(() => {
    if (!drag || count === 0) return;
    setDrag(null);
    // One slice is a click and a click is a jump; anything wider is a
    // range. Nothing else distinguishes them, and nothing else needs to.
    if (drag.from === drag.to) onJump(buckets[clamp(drag.from)].start);
    else commit(Math.min(drag.from, drag.to), Math.max(drag.from, drag.to));
  }, [drag, count, buckets, clamp, onJump, commit]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (count === 0) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onJump(buckets[active].start);
        return;
      }
      if (event.key === "Escape") {
        if (!selection) return;
        event.preventDefault();
        setAnchor(null);
        onClearSelection();
        return;
      }

      const delta =
        event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      const next =
        delta !== 0
          ? Math.min(count - 1, Math.max(0, active + delta))
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? count - 1
              : -1;
      if (next < 0) return;

      event.preventDefault();
      setCursor(next);
      // Shift builds the same range the mouse drags out, so the time
      // filter is not a thing only a pointer can ask for.
      if (event.shiftKey) {
        const base = anchor ?? active;
        setAnchor(base);
        commit(Math.min(base, next), Math.max(base, next));
      } else {
        setAnchor(null);
      }
    },
    [
      count,
      active,
      anchor,
      buckets,
      selection,
      onJump,
      onClearSelection,
      commit,
    ]
  );

  const spanMs = density.to - density.from;
  const summary = useMemo(
    () => describe(density, headDropped, intake),
    [density, headDropped, intake]
  );

  if (retained === 0) {
    return (
      <Frame>
        <Head left="Density over time" intake={intake} />
        <Placeholder>
          Nothing to map yet — the strip fills in as lines arrive.
        </Placeholder>
      </Frame>
    );
  }

  if (count === 0) {
    return (
      <Frame>
        <Head left="Density over time" intake={intake} />
        <Placeholder>
          No line in the buffer matches the query, so there is no shape to show.
        </Placeholder>
      </Frame>
    );
  }

  // One bar over everything is not a map, and drawing it anyway would be
  // a chart pretending to be one.
  if (count < MIN_USEFUL_SLICES) {
    return (
      <Frame>
        <Head left="Density over time" intake={intake} />
        <Placeholder>
          {density.lines === 1 ? (
            <>
              One line so far, at {sliceClock(density.from)} — nothing to map
              until there is a stretch of time to map.
            </>
          ) : (
            <>
              All {formatCount(density.lines)} lines landed within{" "}
              {formatSpan(spanMs)} of each other — too short a stretch to slice.
            </>
          )}
        </Placeholder>
      </Frame>
    );
  }

  const mid = buckets[Math.floor((count - 1) / 2)].start;

  return (
    <Frame>
      <Head
        left={`${formatSpan(spanMs)} in ${stepLabel(step)} slices`}
        errors={density.errors}
        bursts={density.errorSlices}
        warnings={density.warnings}
        intake={intake}
      />

      <div
        ref={barsRef}
        role="listbox"
        tabIndex={0}
        aria-label="Log density over time"
        aria-activedescendant={focused ? `${id}-${active}` : undefined}
        aria-describedby={`${id}-summary`}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        data-testid="log-density-bars"
        // The baseline is what makes an idle stretch read as silence
        // rather than as a strip that failed to draw.
        className="flex cursor-crosshair select-none items-stretch gap-px border-b border-hair outline-none focus-visible:ring-1 focus-visible:ring-fg-fnt"
        style={{ height: RULER_PX + MARK_PX + TRACK_PX + 1 }}
      >
        {buckets.map((bucket, index) => (
          <Slice
            key={bucket.start}
            id={`${id}-${index}`}
            bucket={bucket}
            step={step}
            peak={density.peak}
            inView={inView !== null && index >= inView.lo && index <= inView.hi}
            chosen={chosen !== null && index >= chosen.lo && index <= chosen.hi}
            dimmed={chosen !== null && (index < chosen.lo || index > chosen.hi)}
            cursor={focused && index === active}
          />
        ))}
      </div>

      <div className="mt-0.5 flex justify-between text-[10px] text-fg-fnt">
        <span
          title={
            headDropped
              ? "Older lines have been dropped — the log starts before this."
              : undefined
          }
        >
          {/* The left edge is only the start of the log while nothing has
              been evicted. Once it has, saying so is the difference
              between a window on the log and a claim about it. */}
          {headDropped && <span aria-hidden="true">⋯ </span>}
          {axisLabel(origin, step, spanMs)}
        </span>
        <span>{axisLabel(mid, step, spanMs)}</span>
        <span>{axisLabel(density.to, step, spanMs)}</span>
      </div>

      <p id={`${id}-summary`} className="sr-only">
        {summary}
      </p>
    </Frame>
  );
}

/**
 * One slice. Volume as height against the tallest slice in view, with the
 * two levels worth a colour stacked on top of it — an error burst is
 * three pixels of red at minimum however many quiet lines it is buried
 * in, because a burst that scales to invisibility is not a burst.
 */
function Slice({
  id,
  bucket,
  step,
  peak,
  inView,
  chosen,
  dimmed,
  cursor,
}: {
  id: string;
  bucket: DensityBucket;
  step: number;
  peak: number;
  inView: boolean;
  chosen: boolean;
  dimmed: boolean;
  cursor: boolean;
}) {
  const height =
    bucket.total === 0
      ? 0
      : Math.max(MIN_BAR_PX, Math.round((bucket.total / peak) * TRACK_PX));
  const err =
    bucket.err === 0
      ? 0
      : Math.min(
          height,
          Math.max(
            MIN_LEVEL_PX,
            Math.round((bucket.err / bucket.total) * height)
          )
        );
  const warn =
    bucket.warn === 0
      ? 0
      : Math.min(
          height - err,
          Math.max(
            MIN_LEVEL_PX,
            Math.round((bucket.warn / bucket.total) * height)
          )
        );

  const label = [
    sliceClock(bucket.start),
    stepLabel(step),
    `${formatCount(bucket.total)} ${bucket.total === 1 ? "line" : "lines"}`,
    bucket.err > 0 && `${formatCount(bucket.err)} errors`,
    bucket.warn > 0 && `${formatCount(bucket.warn)} warnings`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      id={id}
      role="option"
      aria-selected={chosen}
      aria-label={label}
      title={label}
      className={`flex min-w-0 flex-1 flex-col rounded-[1px] ${
        chosen ? "bg-sel" : "hover:bg-hover"
      } ${dimmed ? "opacity-40" : ""} ${
        cursor ? "ring-1 ring-inset ring-fg" : ""
      }`}
    >
      {/* Where the reader is. A rail rather than an outline because the
          viewport covers several slices at once and a row of outlines
          reads as a fence. */}
      <span
        aria-hidden="true"
        className={`block w-full transition-none ${inView ? "bg-fg" : ""}`}
        style={{ height: RULER_PX }}
      />
      {/* "There are errors here" said by a mark and not only by a hue. */}
      <span
        aria-hidden="true"
        className="flex items-start justify-center"
        style={{ height: MARK_PX }}
      >
        {bucket.err > 0 && (
          <span className="block h-[3px] w-[3px] rounded-full bg-err" />
        )}
      </span>
      <span
        aria-hidden="true"
        className="flex flex-1 flex-col justify-end overflow-hidden"
      >
        {err > 0 && (
          <span
            className="block w-full transition-none bg-err"
            style={{ height: err }}
          />
        )}
        {warn > 0 && (
          <span
            className="block w-full transition-none bg-warn"
            style={{ height: warn }}
          />
        )}
        <span
          className="block w-full transition-none bg-info/40"
          style={{ height: Math.max(0, height - err - warn) }}
        />
      </span>
    </div>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-none border-b border-hair px-2.5 pb-1 pt-1.5">
      {children}
    </div>
  );
}

/**
 * The header carries the one thing a bar chart cannot: the count of
 * bursts as a number. Colour is never the only thing saying "errors".
 */
function Head({
  left,
  errors = 0,
  bursts = 0,
  warnings = 0,
  intake = false,
}: {
  left: string;
  errors?: number;
  bursts?: number;
  warnings?: number;
  intake?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2 text-[11px] text-fg-fnt">
      <span className="text-fg-mut">{left}</span>
      {errors > 0 && (
        <span className="text-err">
          {formatCount(errors)} {errors === 1 ? "error" : "errors"} in{" "}
          {formatCount(bursts)} {bursts === 1 ? "slice" : "slices"}
        </span>
      )}
      {errors === 0 && warnings > 0 && (
        <span className="text-warn">
          {formatCount(warnings)} {warnings === 1 ? "warning" : "warnings"}
        </span>
      )}
      {/* The one thing a map cannot leave to colour: what it covers. */}
      {intake && (
        <span
          className="ml-auto shrink-0 text-info"
          title="Intake discarded the rest before they reached the buffer, so they are not on this map."
        >
          <span aria-hidden="true">⇣ </span>maps kept lines only
        </span>
      )}
      <span className={`${intake ? "" : "ml-auto "}min-w-0 truncate`}>
        click to jump · drag to filter
      </span>
    </div>
  );
}

/** The strip with nothing to draw, at the height it would have had. */
function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div
        className="flex items-center justify-center text-[11px] text-fg-fnt"
        style={{ height: RULER_PX + MARK_PX + TRACK_PX + 1 }}
      >
        {children}
      </div>
      <div aria-hidden="true" className="mt-0.5 text-[10px] leading-[normal]">
        &nbsp;
      </div>
    </>
  );
}

/**
 * The strip in words.
 *
 * Bar heights are worth nothing to a screen reader, so the same three
 * findings the picture gives — how long, how loud, where the errors are —
 * are stated outright, and the keys that work the thing are named where
 * the mouse hints are visible.
 */
function describe(
  density: Density,
  headDropped: boolean,
  intake: boolean
): string {
  if (density.buckets.length === 0) return "No lines to show.";

  const bursts = density.buckets.filter((bucket) => bucket.err > 0);
  const spoken = bursts
    .slice(0, SPOKEN_BURSTS)
    .map((bucket) => `${sliceClock(bucket.start)} (${bucket.err})`)
    .join(", ");
  const busiest = density.buckets.reduce((best, bucket) =>
    bucket.total > best.total ? bucket : best
  );

  return [
    `Density of the log over time: ${density.buckets.length} slices of ${stepLabel(
      density.step
    )}, from ${sliceClock(density.from)} to ${sliceClock(density.to)}.`,
    `${formatCount(density.lines)} lines, ${formatCount(density.errors)} errors, ${formatCount(density.warnings)} warnings.`,
    `Busiest slice ${sliceClock(busiest.start)} with ${formatCount(busiest.total)} lines.`,
    bursts.length > 0 &&
      `Errors in ${bursts.length} ${bursts.length === 1 ? "slice" : "slices"}: ${spoken}${
        bursts.length > SPOKEN_BURSTS
          ? `, and ${bursts.length - SPOKEN_BURSTS} more`
          : ""
      }.`,
    headDropped &&
      "Older lines have been dropped, so the strip begins later than the log does.",
    intake &&
      "Intake is set, so this covers only the lines it kept; the rest were discarded before they reached the buffer.",
    "Left and right arrows move between slices, Enter scrolls the log to one, shift with the arrows selects a time range, Escape clears it.",
  ]
    .filter(Boolean)
    .join(" ");
}
