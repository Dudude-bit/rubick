import type { ContainerInfo } from "@/generated/types";
import { PHASE_LABEL } from "@/lib/container-sequence";

import type { ContainerFailure } from "./hooks/useLogStream";
import { formatCount } from "./types";
import { useT } from "@/i18n/useT";

/** Its name, when it ran, and whether it ever did. */
export type LegendContainer = Pick<ContainerInfo, "name" | "phase" | "state">;

interface LogLegendProps {
  /** Every container the pod declares, init first and in run order. */
  containers: LegendContainer[];
  colors: Map<string, string>;
  /** Lines retained per container, whether or not it is currently shown. */
  counts: Map<string, number>;
  hidden: ReadonlySet<string>;
  failures: ContainerFailure[];
  onToggle: (container: string) => void;
  /** Everything else off, or — on the container already alone — back on. */
  onSolo: (container: string) => void;
  onShowAll: () => void;
}

/**
 * The legend, which is also the filter.
 *
 * It replaces a dropdown that showed one container and hid the other
 * four — so the one question a multi-container pod raises, what the
 * sidecar was doing when the app failed, could not be asked. Every
 * container is named here with its rule colour and its line count, and
 * clicking one takes it out of the view without stopping its stream, so
 * the count keeps telling the truth while it is hidden.
 *
 * A container whose stream died says so here. Without that a dead
 * sidecar and a quiet one look identical: both stop at a number.
 *
 * Isolating one used to cost a click per container. Click still toggles;
 * double-click or alt-click solos, and the same gesture again brings the
 * rest back — the mute/solo pair from every audio tool, which nobody has
 * to be taught. `1`…`9` do it from the keyboard, by the positions this
 * row is drawn in.
 */
export function LogLegend({
  containers,
  colors,
  counts,
  hidden,
  failures,
  onToggle,
  onSolo,
  onShowAll,
}: LogLegendProps) {
  const t = useT();
  if (containers.length === 0) return null;

  const shown = containers.filter((c) => !hidden.has(c.name));
  const soloed = shown.length === 1 ? shown[0].name : null;

  return (
    <div
      className="flex flex-wrap items-center gap-x-1 gap-y-0.5 border-b border-hair px-2 py-1 text-[11px]"
      data-testid="log-legend"
    >
      {containers.map(({ name, phase, state }, index) => {
        const off = hidden.has(name);
        const solo = soloed === name;
        const failure = failures.find((f) => f.container === name);
        const count = counts.get(name) ?? 0;
        // A hairline where the phase changes: an init container and an
        // app container are not two entries in one list, they are two
        // parts of the pod's life.
        const divides = index > 0 && containers[index - 1].phase !== phase;
        return (
          <span key={name} className="flex items-center">
            {divides && (
              <span
                aria-hidden="true"
                className="mx-1.5 h-3 w-px bg-hair"
                data-testid="log-legend-divider"
              />
            )}
            <button
              type="button"
              aria-pressed={!off}
              aria-keyshortcuts={index < 9 ? `${index + 1}` : undefined}
              title={`${
                off
                  ? t("action", "legendShow", { name })
                  : t("action", "legendHide", { name })
              } ${t("action", "legendSoloHint", { name })}${
                index < 9
                  ? t("action", "legendOrPress", { key: index + 1 })
                  : ""
              }.`}
              onClick={(event) =>
                event.altKey ? onSolo(name) : onToggle(name)
              }
              onDoubleClick={() => onSolo(name)}
              className={`inline-flex items-center gap-1.5 rounded py-0.5 pl-1 pr-1.5 hover:bg-hover ${
                solo ? "bg-sel text-fg" : off ? "text-fg-fnt" : "text-fg-mut"
              }`}
            >
              <span
                aria-hidden="true"
                className={`h-3 w-[3px] rounded-sm ${off ? "opacity-25" : ""}`}
                style={{ background: colors.get(name) }}
              />
              {name}
              {PHASE_LABEL[phase] && (
                <span className="text-[9px] uppercase tracking-[0.04em] text-fg-fnt">
                  {PHASE_LABEL[phase]}
                </span>
              )}
              {/* What has arrived, not what the container wrote — a
               *  container with nothing to say is visible as 0 rather
               *  than by clicking it and finding out. */}
              <span className="font-mono text-[10px] text-fg-fnt">
                {formatCount(count)}
              </span>
              {failure && (
                <span
                  className={
                    failure.kind === "broken" && state.type !== "waiting"
                      ? "text-err"
                      : "text-warn"
                  }
                  title={failure.message}
                >
                  {failure.kind === "no-previous-run"
                    ? "· no earlier run"
                    : failure.kind === "gone"
                      ? "· ended"
                      : // A stream that could never attach was not lost.
                        // The apiserver refuses one for a container that
                        // has not started, and that is a fact about the
                        // pod rather than about the connection.
                        state.type === "waiting"
                        ? "· not started"
                        : "· lost"}
                </span>
              )}
            </button>
          </span>
        );
      })}
      {/* Dimming a chip is a quiet way to say "withheld", and on a row of
       *  five it is easy to read as decoration. The count says it in
       *  words, in the row the hiding happened in. */}
      {hidden.size > 0 && (
        <button
          type="button"
          onClick={onShowAll}
          className="ml-1 rounded px-1.5 py-0.5 text-warn hover:bg-hover"
        >
          {t("count", "hiddenShowAll", { n: hidden.size })}
        </button>
      )}
    </div>
  );
}
