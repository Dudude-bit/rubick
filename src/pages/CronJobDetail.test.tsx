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
    labels: {},
    annotations: {},
    ownerReferences: [],
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function mockDetail(cronJob: CronJobDetailInfo | undefined) {
  vi.mocked(useResourceDetail).mockReturnValue({
    name: cronJob?.name ?? "nightly-backup",
    namespace: cronJob?.namespace ?? "ops",
    resource: cronJob,
    isLoading: false,
    error: null,
    yaml: "kind: CronJob\n",
    copyYaml: vi.fn(),
    activeTab: "overview",
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
});
