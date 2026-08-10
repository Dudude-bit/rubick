import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("draws no track or fill sized as a share of a ceiling", () => {
    // A bar is drawn by putting a percentage width on a fill element. With
    // no denominator there must be nothing on screen whose size claims one.
    const { container } = render(
      <UsageChart
        label="CPU"
        type="cpu"
        samples={series([10, 12, 11, 14])}
        limit={null}
        current={14}
      />
    );
    const sized = container.querySelectorAll('[style*="width"]');
    expect(sized).toHaveLength(0);
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
    // And no empty 42px box where a chart would go.
    expect(container.querySelector("svg")).toBeNull();
  });
});

describe("UsageChart hover", () => {
  it("gives the value and the wall-clock time of the point under the pointer", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <UsageChart
        label="CPU"
        type="cpu"
        samples={series([40, 45, 48, 52])}
        limit={200}
        current={52}
      />
    );
    const plot = container.querySelector("svg")!;
    // jsdom lays nothing out, so the band has to be given a width for the
    // pointer position to map onto a bucket.
    plot.getBoundingClientRect = () =>
      ({ left: 0, width: 400, top: 0, height: 42 }) as DOMRect;

    await user.pointer({ target: plot, coords: { clientX: 400, clientY: 20 } });

    expect(screen.getByRole("status").textContent).toMatch(
      /\d{1,2}:\d{2}:\d{2}/
    );
    expect(screen.getByRole("status").textContent).toMatch(/% of limit/);
    // The noun follows the object: a node has capacity, not limits.
  });

  it("can be scrubbed from the keyboard, so the numbers are not hover-only", async () => {
    const user = userEvent.setup();
    render(
      <UsageChart
        label="CPU"
        type="cpu"
        samples={series([40, 45, 48, 52])}
        limit={200}
        current={52}
      />
    );
    const plot = screen.getByRole("img");
    plot.focus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});

describe("UsageChart restart marks", () => {
  it("describes a restart, since a drop to nothing and a climb back is the shape that matters", () => {
    const samples: UsageSample[] = [
      { t: 1000, cpuMillicores: 40, memoryBytes: null, restarts: 0 },
      { t: 3000, cpuMillicores: 60, memoryBytes: null, restarts: 0 },
      { t: 5000, cpuMillicores: 4, memoryBytes: null, restarts: 1 },
      { t: 7000, cpuMillicores: 30, memoryBytes: null, restarts: 1 },
    ];
    render(
      <UsageChart
        label="Memory"
        type="cpu"
        samples={samples}
        limit={200}
        current={30}
      />
    );
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(
      /1 restart/
    );
  });
});

describe("UsageChart on an object with a capacity rather than limits", () => {
  it("calls the ceiling what the caller calls it", async () => {
    const user = userEvent.setup();
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
    const plot = container.querySelector("svg")!;
    plot.getBoundingClientRect = () =>
      ({ left: 0, width: 400, top: 0, height: 42 }) as DOMRect;
    await user.pointer({ target: plot, coords: { clientX: 400, clientY: 20 } });
    expect(screen.getByRole("status").textContent).toMatch(/% of capacity/);
  });
});
