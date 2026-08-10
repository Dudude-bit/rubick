import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { UsageBlock } from "@/components/resources/usage-block";
import { useUsageHistoryStore } from "@/stores/usageHistoryStore";
import type {
  ConnectionEdge,
  ObjectRef,
  ResourceConnections,
} from "@/generated/types";

const subject: ObjectRef = {
  kind: "Pod",
  name: "mounts-demo",
  namespace: "k8s-gui-test",
  existence: "present",
  facts: null,
};

const withClaim = (): ResourceConnections => {
  const edge: ConnectionEdge = {
    from: subject,
    to: {
      kind: "PersistentVolumeClaim",
      name: "pvc-demo",
      namespace: "k8s-gui-test",
      existence: "present",
      facts: {
        kind: "claim",
        phase: "Bound",
        capacity: "1Gi",
        storageClass: "local-path",
      },
    },
    relation: {
      verb: "uses",
      usages: [
        {
          how: "mount",
          container: "app",
          path: "/var/lib/data",
          readOnly: false,
          subPath: null,
          volume: "data",
          projected: false,
        },
      ],
    },
  };
  return { subject, edges: [edge], stops: [], published: [], notLookedAt: [] };
};

describe("UsageBlock when metrics-server is missing", () => {
  beforeEach(() => useUsageHistoryStore.getState().clear());

  it("degrades to saying so rather than to an empty plot", () => {
    render(
      <UsageBlock
        kind="Pod"
        uid="uid-1"
        cpu={null}
        memory={null}
        cpuLimit={200}
        memoryLimit={null}
        sampledAt={null}
        status={{ status: "notInstalled", message: null }}
      />
    );
    expect(screen.getAllByText("no metrics-server")).toHaveLength(2);
    expect(document.querySelector("svg")).toBeNull();
  });

  it("offers no range picker when there is nothing to range over", () => {
    render(
      <UsageBlock
        kind="Pod"
        uid="uid-1"
        cpu={null}
        memory={null}
        cpuLimit={200}
        memoryLimit={null}
        sampledAt={null}
        status={{ status: "notInstalled", message: null }}
      />
    );
    expect(
      screen.queryByRole("button", { name: "1h" })
    ).not.toBeInTheDocument();
  });
});

describe("UsageBlock range picker", () => {
  beforeEach(() => useUsageHistoryStore.getState().clear());

  it("draws the longer ranges as unavailable rather than pretending they work", () => {
    render(
      <UsageBlock
        kind="Pod"
        uid="uid-2"
        cpu={48}
        memory={null}
        cpuLimit={200}
        memoryLimit={null}
        sampledAt={1_700_000_000_000}
        status={{ status: "available", message: null }}
      />
    );
    for (const range of ["1h", "6h", "24h"]) {
      expect(screen.getByRole("button", { name: range })).toBeDisabled();
    }
  });

  it("names what the ranges are waiting on", () => {
    render(
      <UsageBlock
        kind="Pod"
        uid="uid-2b"
        cpu={48}
        memory={null}
        cpuLimit={200}
        memoryLimit={null}
        sampledAt={1_700_000_000_000}
        status={{ status: "available", message: null }}
      />
    );
    expect(
      screen.getByRole("button", { name: "1h" }).getAttribute("title")
    ).toMatch(/Prometheus/);
  });
});

describe("UsageBlock storage summary", () => {
  beforeEach(() => useUsageHistoryStore.getState().clear());

  const renderWithStorage = () =>
    render(
      <UsageBlock
        kind="Pod"
        uid="uid-3"
        cpu={48}
        memory={null}
        cpuLimit={200}
        memoryLimit={null}
        sampledAt={1_700_000_000_000}
        status={{ status: "available", message: null }}
        connections={withClaim()}
      />
    );

  it("gives the declared size of what the workload mounts", () => {
    renderWithStorage();
    expect(screen.getByText(/pvc-demo/)).toBeInTheDocument();
    expect(screen.getByText("1Gi")).toBeInTheDocument();
  });

  it("says the number is size and not fullness", () => {
    renderWithStorage();
    expect(
      screen.getByText(/Declared size, not how full/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/kubelet Summary API/i)).toBeInTheDocument();
  });

  it("draws no used-vs-total bar for a volume, because nothing measured one", () => {
    const { container } = renderWithStorage();
    const storage = screen.getByText(
      /Declared size, not how full/i
    ).parentElement!;
    expect(storage.querySelectorAll('[style*="width"]')).toHaveLength(0);
    // And no percentage anywhere near the volume line.
    expect(container.textContent).not.toMatch(/1Gi[^.]*\d+\s*%/);
  });
});

describe("UsageBlock window label", () => {
  beforeEach(() => useUsageHistoryStore.getState().clear());

  it("says the history is only what this page has watched", () => {
    render(
      <UsageBlock
        kind="Pod"
        uid="uid-4"
        cpu={48}
        memory={96}
        cpuLimit={200}
        memoryLimit={128}
        sampledAt={Date.now()}
        status={{ status: "available", message: null }}
      />
    );
    expect(
      screen.getByText(/watched since you opened this page/i)
    ).toBeInTheDocument();
  });
});

describe("UsageBlock with no limits at all", () => {
  beforeEach(() => useUsageHistoryStore.getState().clear());

  /** Two polls, so the bands are past "watching from now" and drawing. */
  const renderPolled = (props: {
    uid: string;
    cpuLimit: number | null;
    memoryLimit: number | null;
  }) => {
    const base = {
      kind: "Pod" as const,
      cpu: 12,
      memory: 4096,
      status: { status: "available" as const, message: null },
    };
    const view = render(
      <UsageBlock {...base} {...props} sampledAt={1_700_000_000_000} />
    );
    view.rerender(
      <UsageBlock {...base} {...props} sampledAt={1_700_000_002_000} />
    );
    return view;
  };

  it("says there is no ceiling once, not once per measure", () => {
    renderPolled({ uid: "uid-5", cpuLimit: null, memoryLimit: null });
    expect(screen.getAllByText(/No limit set/i)).toHaveLength(1);
  });

  it("shows neither a denominator nor a percentage for either measure", () => {
    // The live bug: a caption promising "against this pod's limits" over a
    // full-width empty track, on a pod that declares none.
    const { container } = renderPolled({
      uid: "uid-6",
      cpuLimit: null,
      memoryLimit: null,
    });
    expect(container.textContent).not.toMatch(/\d\s*%/);
    // Nothing on either row is sized as a fraction of a ceiling. The chart's
    // own surface fills its band by construction and is not one.
    const shares = [
      ...container.querySelectorAll<HTMLElement>('[style*="width"]'),
    ].filter((element) => !element.closest(".recharts-wrapper"));
    expect(shares).toHaveLength(0);
  });

  it("still attaches the sentence to the one measure that lacks a ceiling", () => {
    const { container } = renderPolled({
      uid: "uid-7",
      cpuLimit: null,
      memoryLimit: 128 * 1024 * 1024,
    });
    expect(screen.getAllByText(/No limit set/i)).toHaveLength(1);
    // The measure that does have one still reads against it.
    expect(container.textContent).toMatch(/\/128Mi/);
  });
});

describe("UsageBlock degraded, on a workload that declares no limits", () => {
  beforeEach(() => useUsageHistoryStore.getState().clear());

  const renderDegraded = () =>
    render(
      <UsageBlock
        kind="Pod"
        uid="uid-8"
        cpu={null}
        memory={null}
        cpuLimit={null}
        memoryLimit={null}
        sampledAt={null}
        status={{ status: "error", message: "503" }}
      />
    );

  it("draws no track, because there is neither a reading nor a denominator", () => {
    // The screenshotted bug, in the one path that still fell back to bars:
    // a full-width empty track under a caption promising a comparison
    // against limits the workload does not declare.
    const { container } = renderDegraded();
    expect(container.querySelectorAll('[style*="width"]')).toHaveLength(0);
    expect(container.textContent).not.toMatch(/\d\s*%/);
  });

  it("does not claim to be measuring against limits that do not exist", () => {
    renderDegraded();
    expect(
      screen.queryByText(/against declared limits/i)
    ).not.toBeInTheDocument();
    expect(screen.getByText(/no limits declared/i)).toBeInTheDocument();
  });
});

describe("UsageBlock in its first seconds", () => {
  beforeEach(() => useUsageHistoryStore.getState().clear());

  it("says the window starts now, once for the pair rather than once per band", () => {
    render(
      <UsageBlock
        kind="Pod"
        uid="uid-9"
        cpu={48}
        memory={96}
        cpuLimit={200}
        memoryLimit={128}
        sampledAt={1_700_000_000_000}
        status={{ status: "available", message: null }}
      />
    );
    expect(screen.getAllByText(/Watching from now/i)).toHaveLength(1);
  });
});
