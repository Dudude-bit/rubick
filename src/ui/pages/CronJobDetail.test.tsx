import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CronJobDetailInfo } from "@/generated/types";

vi.mock("@/hooks", () => ({
  useResourceDetail: vi.fn(),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    getCronjob: vi.fn(async () => buildCronJob()),
    deleteCronjob: vi.fn(),
    listJobs: vi.fn(async () => []),
  },
}));

import { useResourceDetail } from "@/hooks";
import { commands } from "@/lib/commands";
import { CronJobDetail } from "./CronJobDetail";

function buildCronJob(
  overrides: Partial<CronJobDetailInfo> = {}
): CronJobDetailInfo {
  return {
    name: "nightly-backup",
    namespace: "ops",
    uid: "cronjob-uid",
    schedule: "0 3 * * *",
    timezone: null,
    suspend: false,
    concurrencyPolicy: "Forbid",
    startingDeadlineSeconds: null,
    successfulJobsHistoryLimit: 3,
    failedJobsHistoryLimit: 1,
    active: 0,
    lastSchedule: new Date(Date.now() - 3_600_000).toISOString(),
    lastSuccessfulTime: new Date(Date.now() - 3_600_000).toISOString(),
    containers: [],
    initContainers: [],
    serviceAccountName: null,
    podResources: { requests: {}, limits: {} },
    replica: {
      cpuRequests: null,
      cpuLimits: null,
      memoryRequests: null,
      memoryLimits: null,
      known: true,
    },
    labels: {},
    annotations: {},
    ownerReferences: [],
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function mockDetail(
  cronJob: CronJobDetailInfo | undefined,
  activeTab = "overview"
) {
  vi.mocked(useResourceDetail).mockReturnValue({
    name: cronJob?.name ?? "nightly-backup",
    namespace: cronJob?.namespace ?? "ops",
    resource: cronJob,
    isLoading: false,
    error: null,
    yaml: "kind: CronJob\n",
    copyYaml: vi.fn(),
    activeTab,
    setActiveTab: vi.fn(),
    goBack: vi.fn(),
    refetch: vi.fn(),
    deleteMutation: { mutate: vi.fn(), isPending: false },
  } as unknown as ReturnType<typeof useResourceDetail>);
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/cronjobs/ops/nightly-backup"]}>
        <CronJobDetail />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("CronJobDetail", () => {
  beforeEach(() => mockDetail(buildCronJob()));

  it("leads with the schedule, in cron and in words", () => {
    renderPage();
    expect(screen.getByText("0 3 * * *")).toBeInTheDocument();
    expect(screen.getByText(/daily at 03:00/)).toBeInTheDocument();
  });

  it("answers when it last ran and when it runs next", () => {
    renderPage();
    expect(screen.getByText("Last run")).toBeInTheDocument();
    expect(screen.getByText("1h ago")).toBeInTheDocument();
    expect(screen.getByText("Next run")).toBeInTheDocument();
    expect(screen.getByText(/^in /)).toBeInTheDocument();
  });

  it("says a suspended CronJob is not going to fire", () => {
    mockDetail(buildCronJob({ suspend: true }));
    renderPage();
    expect(screen.getByText("suspended")).toBeInTheDocument();
    expect(
      screen.getByText(/nothing will start until the suspend flag is cleared/)
    ).toBeInTheDocument();
  });

  it("admits it cannot read an unparsable schedule instead of guessing", () => {
    mockDetail(buildCronJob({ schedule: "every other tuesday" }));
    renderPage();
    expect(screen.getByText("unknown")).toBeInTheDocument();
    expect(
      screen.getByText("the schedule could not be read")
    ).toBeInTheDocument();
  });

  it("flags a CronJob that has fired but never succeeded", () => {
    mockDetail(buildCronJob({ lastSuccessfulTime: null }));
    renderPage();
    expect(screen.getByText("no run has succeeded yet")).toBeInTheDocument();
  });

  it("renders nothing when the CronJob is absent and nothing is in flight", () => {
    mockDetail(undefined);
    const { container } = renderPage();
    expect(container.firstChild).toBeNull();
  });

  /**
   * A refused Job list was caught and answered with an empty one, so the
   * page drew "0 kept" beside a peek that said it could not read the runs.
   */
  it("says the runs could not be read rather than that there are none", async () => {
    vi.mocked(commands.listJobs).mockRejectedValueOnce(
      new Error(
        'jobs.batch is forbidden: User "kirya" cannot list resource "jobs"'
      )
    );
    renderPage();
    expect(
      await screen.findByText("Could not read this CronJob's runs.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/jobs kept/)).toBeNull();
  });

  /**
   * The Jobs tab reads the same refused list. Its count, its tab mark and its
   * empty state would each say "none" — "0 kept", a 0 on the tab, "has not
   * run yet" — about runs nobody could list.
   */
  it("says on the Jobs tab that the runs could not be read", async () => {
    vi.mocked(commands.listJobs).mockRejectedValueOnce(
      new Error(
        'jobs.batch is forbidden: User "kirya" cannot list resource "jobs"'
      )
    );
    mockDetail(buildCronJob(), "jobs");
    renderPage();
    expect(
      await screen.findByText("Could not read this CronJob's runs.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/kept · history limits/)).toBeNull();
    expect(screen.queryByText("This CronJob has not run yet")).toBeNull();
    expect(screen.getByRole("tab", { name: /Jobs/ }).textContent).not.toMatch(
      /\d/
    );
  });

  /** The other side: a list that was read and is empty says so. */
  it("says on the Jobs tab that a CronJob with no runs has not run", async () => {
    mockDetail(buildCronJob(), "jobs");
    renderPage();
    expect(
      await screen.findByText("This CronJob has not run yet")
    ).toBeInTheDocument();
    expect(screen.getByText(/0 kept · history limits/)).toBeInTheDocument();
  });
});
