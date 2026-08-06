import type { ContainerFailure } from "./hooks/useLogStream";
import { formatCount } from "./types";

interface LogLegendProps {
  /** Every container the pod declares, in spec order. */
  containers: string[];
  colors: Map<string, string>;
  /** Lines retained per container, whether or not it is currently shown. */
  counts: Map<string, number>;
  hidden: ReadonlySet<string>;
  failures: ContainerFailure[];
  onToggle: (container: string) => void;
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
 */
export function LogLegend({
  containers,
  colors,
  counts,
  hidden,
  failures,
  onToggle,
  onShowAll,
}: LogLegendProps) {
  if (containers.length === 0) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-x-1 gap-y-0.5 border-b border-hair px-2 py-1 text-[11px]"
      data-testid="log-legend"
    >
      {containers.map((name) => {
        const off = hidden.has(name);
        const failure = failures.find((f) => f.container === name);
        const count = counts.get(name) ?? 0;
        return (
          <button
            key={name}
            type="button"
            aria-pressed={!off}
            title={
              off
                ? `Show ${name} in the view`
                : `Hide ${name} from the view (its stream keeps running)`
            }
            onClick={() => onToggle(name)}
            className={`inline-flex items-center gap-1.5 rounded py-0.5 pl-1 pr-1.5 hover:bg-hover ${
              off ? "text-fg-fnt" : "text-fg-mut"
            }`}
          >
            <span
              aria-hidden="true"
              className={`h-3 w-[3px] rounded-sm ${off ? "opacity-25" : ""}`}
              style={{ background: colors.get(name) }}
            />
            {name}
            <span className="font-mono text-[10px] text-fg-fnt">
              {formatCount(count)}
            </span>
            {failure && (
              <span
                className={failure.kind === "gone" ? "text-warn" : "text-err"}
                title={failure.message}
              >
                {failure.kind === "gone" ? "· ended" : "· lost"}
              </span>
            )}
          </button>
        );
      })}
      {hidden.size > 0 && (
        <button
          type="button"
          onClick={onShowAll}
          className="ml-1 rounded px-1.5 py-0.5 text-fg-fnt hover:bg-hover hover:text-fg-mut"
        >
          Show all
        </button>
      )}
    </div>
  );
}
