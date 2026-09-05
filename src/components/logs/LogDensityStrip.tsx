import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import type { DensityStripMode } from "@/stores/displaySettingsStore";

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
import { useT } from "@/i18n/useT";

/**
 * The strip: the retained buffer as a map you can click.
 *
 * Scrolling answers "watch it happen"; "what broke" and "find the burst four
 * minutes ago" need the shape of the whole buffer on screen at once. Height
 * is volume, the worst level in a slice stacks on top in its own colour, the
 * slice the reader is looking at is marked, clicking a slice scrolls there
 * and dragging across bounds the query by time. That two-way tie to the
 * viewport is what makes it a map rather than a chart above a log.
 *
 * Hiding the chart must not cost the navigation, so it collapses to a
 * nine-pixel band rather than to nothing. In "band" height stops meaning
 * volume and means severity, and every other tie holds: the same slices, the
 * viewport rail still tracks, a click still jumps, a drag still bounds the
 * query, the keys still work and the spoken summary is word for word the
 * same one.
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

/**
 * Every row the strip is built from, in pixels.
 *
 * Spelled out because the collapse animates between two heights and both
 * have to be known before either is rendered — a measured height would
 * mean a first frame at the wrong size on every mount. The text rows carry
 * a matching `leading-*` so the constant is the height, not a guess at it.
 */
const HEAD_PX = 16;
const AXIS_PX = 14;
const AXIS_GAP_PX = 2;
const HAIRLINE_PX = 1;
const BARS_PX = RULER_PX + MARK_PX + TRACK_PX + HAIRLINE_PX;
const FULL_PX = 6 + HEAD_PX + BARS_PX + AXIS_GAP_PX + AXIS_PX + 4 + HAIRLINE_PX;

/**
 * The band. An error slice is the full six pixels, a warning four, an
 * ordinary slice two — so where the errors are is carried by shape as well
 * as by hue, the one promise the full strip makes that a few pixels could
 * still have broken.
 */
const BAND_ERR_PX = 6;
const BAND_WARN_PX = 4;
const BAND_LINE_PX = 2;
const BAND_PAD_PX = 3;
const BAND_BARS_PX = RULER_PX + BAND_ERR_PX;
/** Set by the toggle beside the bars, not by the bars: nine pixels is a
 *  ruler, and a nine pixel button is a dare. */
const BAND_ROW_PX = 12;
const BAND_PX = BAND_PAD_PX * 2 + BAND_ROW_PX + HAIRLINE_PX;

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
  /** Drawn in full, or as the band. "off" never mounts this. */
  mode: Exclude<DensityStripMode, "off">;
  onModeChange: (mode: DensityStripMode) => void;
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
  mode,
  onModeChange,
}: LogDensityStripProps) {
  const t = useT();
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

  // The accumulator has to survive renders and be advanced during one, which
  // is what the rule below prevents. Safe here for two reasons:
  // `advanceDensity` is idempotent — run twice on the same buffer it finds
  // its own tail and counts nothing, so a double render cannot double-count —
  // and every input it reads is a dependency of this memo, so the render
  // cannot be stale. An effect instead would cost a second render pass four
  // times a second, on the one component that is redrawing anyway.
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
    () => describe(density, headDropped, intake, t),
    [density, headDropped, intake, t]
  );

  const band = mode === "band";
  const toggle = <StripToggle mode={mode} onModeChange={onModeChange} />;

  // Why there is no map, in one sentence — shown in place of the bars when
  // the strip is open and spoken in both states.
  const quiet =
    retained === 0
      ? t("empty", "nothingToMapYet")
      : count === 0
        ? t("empty", "noLineMatchesInBuffer")
        : density.lines === 1
          ? t("empty", "oneLineSoFar", { clock: sliceClock(density.from) })
          : t("empty", "allLinesWithinSpan", {
              count: formatCount(density.lines),
              span: formatSpan(spanMs),
            });

  // One bar over everything is not a map, and drawing it anyway would be
  // a chart pretending to be one.
  const hasShape = retained > 0 && count >= MIN_USEFUL_SLICES;

  // Built once for both shapes, handlers and all: the band is this listbox
  // at another height, not a second control that happens to look like it.
  const bars = hasShape ? (
    <div
      ref={barsRef}
      role="listbox"
      tabIndex={0}
      aria-label={t("action", "logDensityOverTime")}
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
      className={`flex flex-1 cursor-crosshair select-none items-stretch gap-px outline-hidden focus-visible:ring-1 focus-visible:ring-fg-fnt ${
        band ? "" : "border-b border-hair"
      }`}
      style={{ height: band ? BAND_BARS_PX : BARS_PX }}
    >
      {buckets.map((bucket, index) => (
        <Slice
          key={bucket.start}
          id={`${id}-${index}`}
          bucket={bucket}
          step={step}
          peak={density.peak}
          band={band}
          inView={inView !== null && index >= inView.lo && index <= inView.hi}
          chosen={chosen !== null && index >= chosen.lo && index <= chosen.hi}
          dimmed={chosen !== null && (index < chosen.lo || index > chosen.hi)}
          cursor={focused && index === active}
        />
      ))}
    </div>
  ) : null;

  if (band) {
    return (
      <Frame mode={mode}>
        <div
          className="flex items-center gap-1.5"
          style={{ height: BAND_ROW_PX }}
        >
          {/* The one thing the band may not drop with the header: a map
              that has quietly stopped covering the log. */}
          {intake && (
            <span
              className="flex-none text-[9px] leading-none text-info"
              title={t("empty", "intakeNotOnBand")}
            >
              <span aria-hidden="true">⇣</span>
              <span className="sr-only">
                {t("action", "mapsKeptLinesOnly")}
              </span>
            </span>
          )}
          {bars ?? (
            <span
              title={quiet}
              className="flex flex-1 items-end"
              style={{ height: BAND_BARS_PX }}
            >
              <span aria-hidden="true" className="h-px w-full bg-hair" />
            </span>
          )}
          {toggle}
        </div>
        <p id={`${id}-summary`} className="sr-only">
          {hasShape ? summary : quiet}
        </p>
      </Frame>
    );
  }

  if (!hasShape) {
    return (
      <Frame mode={mode}>
        <Head
          left={t("action", "densityOverTime")}
          intake={intake}
          toggle={toggle}
        />
        <Placeholder>{quiet}</Placeholder>
      </Frame>
    );
  }

  const mid = buckets[Math.floor((count - 1) / 2)].start;

  return (
    <Frame mode={mode}>
      <Head
        left={t("count", "spanInSlices", {
          span: formatSpan(spanMs),
          step: stepLabel(step),
        })}
        errors={density.errors}
        bursts={density.errorSlices}
        warnings={density.warnings}
        intake={intake}
        toggle={toggle}
      />

      <div className="flex">{bars}</div>

      <div
        className="mt-0.5 flex items-center justify-between text-[10px] leading-[14px] text-fg-fnt"
        style={{ height: AXIS_PX }}
      >
        <span
          title={headDropped ? t("empty", "olderLinesDroppedAxis") : undefined}
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
 * The way in and out of the band, in the one place a reader is already
 * looking when they decide the chart is in the way.
 *
 * Full hiding is not here: it belongs in the ⋯ menu, because a control
 * that removes itself leaves nothing behind to bring it back.
 */
function StripToggle({
  mode,
  onModeChange,
}: {
  mode: Exclude<DensityStripMode, "off">;
  onModeChange: (mode: DensityStripMode) => void;
}) {
  const t = useT();
  const band = mode === "band";
  const label = band
    ? t("action", "expandDensityStrip")
    : t("action", "collapseDensityStrip");
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-expanded={!band}
      onClick={() => onModeChange(band ? "full" : "band")}
      // Taller than the band it sits in, into the padding on either side:
      // the row is a ruler, and a nine pixel hit target is not a control.
      className={`flex w-5 flex-none items-center justify-center rounded-[2px] text-fg-fnt hover:bg-hover hover:text-fg focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-fg-fnt ${
        band ? "my-[-3px] h-[18px]" : "h-4"
      }`}
    >
      {band ? (
        <ChevronDown aria-hidden="true" className="h-3 w-3" />
      ) : (
        <ChevronUp aria-hidden="true" className="h-3 w-3" />
      )}
    </button>
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
  band,
  inView,
  chosen,
  dimmed,
  cursor,
}: {
  id: string;
  bucket: DensityBucket;
  step: number;
  peak: number;
  /** Collapsed: severity as height, and no room for volume. */
  band: boolean;
  inView: boolean;
  chosen: boolean;
  dimmed: boolean;
  cursor: boolean;
}) {
  const t = useT();
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
    `${formatCount(bucket.total)} ${t("count", "lineNoun", { n: bucket.total })}`,
    bucket.err > 0 &&
      `${formatCount(bucket.err)} ${t("count", "errorNoun", { n: bucket.err })}`,
    bucket.warn > 0 &&
      `${formatCount(bucket.warn)} ${t("count", "warningNoun", { n: bucket.warn })}`,
  ]
    .filter(Boolean)
    .join(" · ");

  const chrome = `flex min-w-0 flex-1 flex-col rounded-[1px] ${
    chosen ? "bg-sel" : "hover:bg-hover"
  } ${dimmed ? "opacity-40" : ""} ${cursor ? "ring-1 ring-inset ring-fg" : ""}`;

  if (band) {
    const level =
      bucket.err > 0
        ? { px: BAND_ERR_PX, tone: "bg-err" }
        : bucket.warn > 0
          ? { px: BAND_WARN_PX, tone: "bg-warn" }
          : bucket.total > 0
            ? { px: BAND_LINE_PX, tone: "bg-info/40" }
            : null;
    return (
      <div
        id={id}
        role="option"
        aria-selected={chosen}
        aria-label={label}
        title={label}
        className={chrome}
      >
        <span
          aria-hidden="true"
          className={`block w-full transition-none ${inView ? "bg-fg" : ""}`}
          style={{ height: RULER_PX }}
        />
        <span
          aria-hidden="true"
          className="flex flex-1 flex-col justify-end overflow-hidden"
        >
          {level && (
            <span
              className={`block w-full transition-none ${level.tone}`}
              style={{ height: level.px }}
            />
          )}
        </span>
      </div>
    );
  }

  return (
    <div
      id={id}
      role="option"
      aria-selected={chosen}
      aria-label={label}
      title={label}
      className={chrome}
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

/**
 * The strip's outline, at whichever of its two heights.
 *
 * Both are constants, so the collapse is one CSS transition on `height`
 * and the list below it slides rather than jumps. The app-wide
 * reduced-motion rule already flattens it; the variant says so here too.
 */
function Frame({
  mode,
  children,
}: {
  mode: Exclude<DensityStripMode, "off">;
  children: React.ReactNode;
}) {
  const band = mode === "band";
  return (
    <div
      data-testid="log-density-strip"
      data-mode={mode}
      style={{ height: band ? BAND_PX : FULL_PX }}
      className={`flex-none overflow-hidden border-b border-hair px-2.5 transition-[height] duration-200 ease-out motion-reduce:transition-none ${
        band ? "py-[3px]" : "pb-1 pt-1.5"
      }`}
    >
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
  toggle,
}: {
  left: string;
  errors?: number;
  bursts?: number;
  warnings?: number;
  intake?: boolean;
  /** The way out of the chart, where the chart says what it is. */
  toggle: ReactNode;
}) {
  const t = useT();
  return (
    <div
      className="flex items-center gap-2 text-[11px] leading-4 text-fg-fnt"
      style={{ height: HEAD_PX }}
    >
      <span className="text-fg-mut">{left}</span>
      {errors > 0 && (
        <span className="text-err">
          {formatCount(errors)} {t("count", "errorNoun", { n: errors })}{" "}
          {t("count", "inSliceCount", { n: bursts })}
        </span>
      )}
      {errors === 0 && warnings > 0 && (
        <span className="text-warn">
          {formatCount(warnings)} {t("count", "warningNoun", { n: warnings })}
        </span>
      )}
      {/* The one thing a map cannot leave to colour: what it covers. */}
      {intake && (
        <span
          className="ml-auto shrink-0 text-info"
          title={t("empty", "intakeNotOnMap")}
        >
          <span aria-hidden="true">⇣ </span>
          {t("action", "mapsKeptLinesOnly")}
        </span>
      )}
      <span className={`${intake ? "" : "ml-auto "}min-w-0 truncate`}>
        {t("action", "clickToJumpDragToFilter")}
      </span>
      {toggle}
    </div>
  );
}

/** The strip with nothing to draw, at the height it would have had. */
function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div
        className="flex items-center justify-center text-[11px] text-fg-fnt"
        style={{ height: BARS_PX }}
      >
        {children}
      </div>
      <div
        aria-hidden="true"
        className="mt-0.5 text-[10px] leading-[14px]"
        style={{ height: AXIS_PX }}
      >
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
  intake: boolean,
  t: ReturnType<typeof useT>
): string {
  if (density.buckets.length === 0) return t("empty", "noLinesToShow");

  const bursts = density.buckets.filter((bucket) => bucket.err > 0);
  const spoken = bursts
    .slice(0, SPOKEN_BURSTS)
    .map((bucket) => `${sliceClock(bucket.start)} (${bucket.err})`)
    .join(", ");
  const busiest = density.buckets.reduce((best, bucket) =>
    bucket.total > best.total ? bucket : best
  );

  return [
    t("count", "densitySummary", {
      n: density.buckets.length,
      step: stepLabel(density.step),
      from: sliceClock(density.from),
      to: sliceClock(density.to),
    }),
    t("count", "densityTotals", {
      lines: formatCount(density.lines),
      errors: formatCount(density.errors),
      warnings: formatCount(density.warnings),
    }),
    t("count", "busiestSlice", {
      clock: sliceClock(busiest.start),
      n: formatCount(busiest.total),
    }),
    bursts.length > 0 &&
      `${t("count", "errorsInSlices", { n: bursts.length, list: spoken })}${
        bursts.length > SPOKEN_BURSTS
          ? t("count", "andNMore", { n: bursts.length - SPOKEN_BURSTS })
          : ""
      }.`,
    headDropped && t("empty", "olderLinesDroppedSummary"),
    intake && t("empty", "intakeCoversKeptOnly"),
    t("action", "densityKeysHint"),
  ]
    .filter(Boolean)
    .join(" ");
}
