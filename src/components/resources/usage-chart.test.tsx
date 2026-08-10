import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UsageChart } from "@/components/resources/usage-chart";
import type { UsageSample } from "@/lib/usage-history";

const series = (values: number[], from = 1_700_000_000_000): UsageSample[] =>
  values.map((cpuMillicores, index) => ({
    t: from + index * 2000,
    cpuMillicores,
    memoryBytes: null,
    restarts: null,
  }));

/**
 * Hovers the band and waits for what it says.
 *
 * jsdom lays nothing out, and recharts asks the DOM where the pointer landed
 * relative to the chart, so the wrapper has to be given a box before a hover
 * can resolve to a bucket at all. The move is repeated on every poll because
 * recharts answers a pointer on the next animation frame, which jsdom serves
 * on its own schedule.
 */
async function hover(
  container: HTMLElement,
  clientX: number,
  expected: RegExp
) {
  const wrapper = container.querySelector<HTMLElement>(".recharts-wrapper")!;
  wrapper.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 600, height: 56 }) as DOMRect;
  Object.defineProperty(wrapper, "offsetWidth", { value: 600 });
  Object.defineProperty(wrapper, "offsetHeight", { value: 56 });
  await waitFor(() => {
    fireEvent.mouseMove(wrapper, { clientX, clientY: 28 });
    expect(screen.getByRole("status").textContent).toMatch(expected);
  });
  return screen.getByRole("status");
}

/**
 * The shape a bar fill takes: an element sized as a share of a ceiling.
 * The chart's own surface fills its band by construction and is not one.
 */
const shares = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("[style*='width']")].filter(
    (element) =>
      !element.closest(".recharts-wrapper") &&
      /width:\s*\d+(\.\d+)?%/.test(element.getAttribute("style")!)
  );

describe("UsageChart with no limit", () => {
  it("says there is no limit instead of drawing a proportion of nothing", () => {
    render(
      <UsageChart
        label="CPU"
        type="cpu"
        samples={series([10, 12, 11, 14])}
        limit={null}
        current={14}
      />
    );
    expect(screen.getByText(/No limit set/i)).toBeInTheDocument();
  });

  it("offers the reader no percentage, because there is nothing to be a percentage of", () => {
    // The bug this replaces: a caption promising "against this pod's limits"
    // over a full-width empty track, which reads as 0% used.
    const { container } = render(
      <UsageChart
        label="CPU"
        type="cpu"
        samples={series([10, 12, 11, 14])}
        limit={null}
        current={14}
      />
    );
    expect(container.textContent).not.toMatch(/\d\s*%/);
    expect(container.textContent).not.toMatch(/\//);
  });

  it("draws neither a track nor a threshold rule with no ceiling to put one at", () => {
    const { container } = render(
      <UsageChart
        label="CPU"
        type="cpu"
        samples={series([10, 12, 11, 14])}
        limit={null}
        current={14}
      />
    );
    expect(shares(container)).toHaveLength(0);
    // The baseline hairline is the only rule a band without a limit gets.
    expect(container.querySelectorAll(".recharts-reference-line")).toHaveLength(
      1
    );
    expect(container.textContent).not.toMatch(/limit \d/);
  });

  it("tells a screen reader the scale is what was used, not a limit", () => {
    render(
      <UsageChart
        label="CPU"
        type="cpu"
        samples={series([10, 12, 11, 90])}
        limit={null}
        current={90}
      />
    );
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(
      /no limit set, scaled to/i
    );
  });
});

describe("UsageChart with a limit", () => {
  it("reads how close it is without the reader doing the arithmetic", () => {
    const { container } = render(
      <UsageChart
        label="CPU"
        type="cpu"
        samples={series([40, 45, 48])}
        limit={200}
        current={48}
      />
    );
    expect(container.textContent).toMatch(/48m\/200m · 24\s*%/);
    expect(screen.queryByText(/No limit set/i)).not.toBeInTheDocument();
  });

  it("draws the ceiling as a dashed rule carrying its own value", () => {
    const { container } = render(
      <UsageChart
        label="CPU"
        type="cpu"
        samples={series([40, 45, 48])}
        limit={200}
        current={48}
      />
    );
    const dashed = [
      ...container.querySelectorAll(".recharts-reference-line line"),
    ].filter((line) => line.getAttribute("stroke-dasharray") !== null);
    expect(dashed).toHaveLength(1);
    expect(container.querySelector("svg")!.textContent).toContain("limit 200m");
  });

  it("names the limit in the description a screen reader gets", () => {
    render(
      <UsageChart
        label="Memory"
        type="memory"
        samples={[
          {
            t: 1,
            cpuMillicores: null,
            memoryBytes: 96 * 1024 * 1024,
            restarts: null,
          },
          {
            t: 2000,
            cpuMillicores: null,
            memoryBytes: 100 * 1024 * 1024,
            restarts: null,
          },
        ]}
        limit={128 * 1024 * 1024}
        current={100 * 1024 * 1024}
      />
    );
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(
      /limit 128Mi/
    );
  });
});

describe("UsageChart before there is a line", () => {
  it("says the window starts now rather than showing an empty box", () => {
    render(
      <UsageChart
        label="CPU"
        type="cpu"
        samples={series([31])}
        limit={200}
        current={31}
      />
    );
    expect(
      screen.getByText(/metrics-server keeps no history/i)
    ).toBeInTheDocument();
  });

  it("draws the one reading as a point, not as a line joining nothing", () => {
    const { container } = render(
      <UsageChart
        label="CPU"
        type="cpu"
        samples={series([31])}
        limit={200}
        current={31}
      />
    );
    expect(container.querySelectorAll(".recharts-dot").length).toBeGreaterThan(
      0
    );
  });

  it("still shows the reading it does have", () => {
    render(
      <UsageChart
        label="CPU"
        type="cpu"
        samples={series([31])}
        limit={null}
        current={31}
      />
    );
    expect(screen.getByText("31")).toBeInTheDocument();
  });

  it("says nothing is reporting rather than reporting zero", () => {
    // metrics-server is up — the block would not be drawing bands at all
    // otherwise — so the honest sentence is that it has no reading for
    // this object, not that the cluster lacks the server.
    const { container } = render(
      <UsageChart
        label="CPU"
        type="cpu"
        samples={[]}
        limit={200}
        current={null}
      />
    );
    expect(screen.getByText("not reporting")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    // And no empty band where a chart would go.
    expect(container.querySelector("svg")).toBeNull();
  });
});

describe("UsageChart gaps", () => {
  it("breaks the line rather than bridging a bucket nothing was sampled in", () => {
    const { container } = render(
      <UsageChart
        label="CPU"
        type="cpu"
        samples={[
          { t: 1000, cpuMillicores: 40, memoryBytes: null, restarts: null },
          { t: 3000, cpuMillicores: 44, memoryBytes: null, restarts: null },
          { t: 5000, cpuMillicores: null, memoryBytes: null, restarts: null },
          { t: 7000, cpuMillicores: 46, memoryBytes: null, restarts: null },
          { t: 9000, cpuMillicores: 48, memoryBytes: null, restarts: null },
        ]}
        limit={200}
        current={48}
      />
    );
    const line = container.querySelector(".recharts-area-curve")!;
    // Two runs, not one: a straight segment across missing data would be a
    // claim that nothing happened there, and nobody knows that.
    expect(line.getAttribute("d")!.match(/M/g)).toHaveLength(2);
  });
});

describe("UsageChart hover", () => {
  it("gives the value and the wall-clock time of the point under the pointer", async () => {
    const { container } = render(
      <UsageChart
        label="CPU"
        type="cpu"
        samples={series([40, 45, 48, 52])}
        limit={200}
        current={52}
      />
    );
    const tip = await hover(container, 560, /\d{1,2}:\d{2}:\d{2}/);
    expect(tip.textContent).toMatch(/\d+m/);
    // The noun follows the object: a node has capacity, not limits.
    expect(tip.textContent).toMatch(/% of limit/);
    expect(tip.textContent).toMatch(/ago/);
  });

  it("can be scrubbed from the keyboard, so the numbers are not hover-only", async () => {
    const { container } = render(
      <UsageChart
        label="CPU"
        type="cpu"
        samples={series([40, 45, 48, 52])}
        limit={200}
        current={52}
      />
    );
    const plot = container.querySelector<SVGSVGElement>(".recharts-surface")!;
    fireEvent.focus(plot);
    fireEvent.keyDown(plot, { key: "ArrowLeft" });
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
  });
});

describe("UsageChart restart marks", () => {
  const restarted: UsageSample[] = [
    { t: 1000, cpuMillicores: 40, memoryBytes: null, restarts: 0 },
    { t: 3000, cpuMillicores: 60, memoryBytes: null, restarts: 0 },
    { t: 5000, cpuMillicores: 4, memoryBytes: null, restarts: 1 },
    { t: 7000, cpuMillicores: 30, memoryBytes: null, restarts: 1 },
  ];

  it("describes a restart, since a drop to nothing and a climb back is the shape that matters", () => {
    render(
      <UsageChart
        label="Memory"
        type="cpu"
        samples={restarted}
        limit={200}
        current={30}
      />
    );
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(
      /1 restart/
    );
  });

  it("marks it on the band as a vertical rule of its own", () => {
    const { container } = render(
      <UsageChart
        label="CPU"
        type="cpu"
        samples={restarted}
        limit={200}
        current={30}
      />
    );
    const vertical = [
      ...container.querySelectorAll(".recharts-reference-line line"),
    ].filter((line) => line.getAttribute("x1") === line.getAttribute("x2"));
    expect(vertical).toHaveLength(1);
  });
});

describe("UsageChart on an object with a capacity rather than limits", () => {
  it("calls the ceiling what the caller calls it", async () => {
    const { container } = render(
      <UsageChart
        label="CPU"
        type="cpu"
        samples={series([40, 45, 48, 52])}
        limit={200}
        limitNoun="capacity"
        current={52}
      />
    );
    await hover(container, 560, /% of capacity/);
  });
});

describe("UsageChart motion", () => {
  it("never animates: the poll is every few seconds and a band that redraws itself is noise", () => {
    const { container } = render(
      <UsageChart
        label="CPU"
        type="cpu"
        samples={series([40, 45, 48, 52])}
        limit={200}
        current={52}
      />
    );
    // recharts animates by mounting its own <animate>/CSS transitions; with
    // animation off the mark is drawn once, at its final geometry.
    expect(container.querySelectorAll("animate")).toHaveLength(0);
    const area = container.querySelector<SVGPathElement>(
      ".recharts-area-area"
    )!;
    expect(area.style.transition).toBe("");
  });
});
