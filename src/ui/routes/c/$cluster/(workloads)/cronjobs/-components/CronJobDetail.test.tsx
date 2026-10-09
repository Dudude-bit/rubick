import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CronJobDetailInfo } from "@/generated/types";

vi.mock("@/hooks", () => ({
  useResourceDetail: vi.fn(),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    getCronjob: vi.fn(async () => buildCronJob()),
    deleteCronjob: vi.fn(),
    listJobs: vi.fn(async () => []),
    triggerCronjob: vi.fn(async () => "nightly-backup-1"),
    checkAccess: vi.fn(),
  },
}));

import { useResourceDetail } from "@/hooks";
import { commands } from "@/lib/commands";
import { renderWithRouter } from "@/test/render";
import { CronJobDetail } from "./CronJobDetail";
import { useClusterStore } from "@/stores/clusterStore";
import { marcoReview } from "@/test/marco";

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
  return renderWithRouter(<CronJobDetail />, {
    at: "/c/prod/cronjobs/ops/nightly-backup",
    route: "/c/$cluster/cronjobs/$namespace/$name",
  });
}

describe("CronJobDetail", () => {
  beforeEach(() => mockDetail(buildCronJob()));

  it("leads with the schedule, in cron and in words", async () => {
    await renderPage();
    expect(screen.getByText("0 3 * * *")).toBeInTheDocument();
    expect(screen.getByText(/daily at 03:00/)).toBeInTheDocument();
  });

  it("answers when it last ran and when it runs next", async () => {
    await renderPage();
    expect(screen.getByText("Last run")).toBeInTheDocument();
    expect(screen.getByText("1h ago")).toBeInTheDocument();
    expect(screen.getByText("Next run")).toBeInTheDocument();
    expect(screen.getByText(/^in /)).toBeInTheDocument();
  });

  it("says a suspended CronJob is not going to fire", async () => {
    mockDetail(buildCronJob({ suspend: true }));
    await renderPage();
    expect(screen.getByText("suspended")).toBeInTheDocument();
    expect(
      screen.getByText(/nothing will start until the suspend flag is cleared/)
    ).toBeInTheDocument();
  });

  it("admits it cannot read an unparsable schedule instead of guessing", async () => {
    mockDetail(buildCronJob({ schedule: "every other tuesday" }));
    await renderPage();
    expect(screen.getByText("unknown")).toBeInTheDocument();
    expect(
      screen.getByText("the schedule could not be read")
    ).toBeInTheDocument();
  });

  /**
   * Lena's shop/reports said "missed runs are skipped" with
   * startingDeadlineSeconds unset. The CronJob controller (`nextScheduleTime`
   * and `syncCronJob` in pkg/controller/cronjob) skips a run only past a set
   * deadline; unset, it starts the latest missed one however late. Fails if
   * the page says an unset deadline skips anything.
   */
  it("says a CronJob with no starting deadline still starts its latest missed run", async () => {
    await renderPage();
    expect(
      screen.getByText("none: the latest missed run still starts, however late")
    ).toBeInTheDocument();
    expect(screen.queryByText(/skipped/)).toBeNull();
  });

  /** A deadline of 0 is a deadline: a run that is late at all is skipped. Fails if 0 reads as unset. */
  it("reads a starting deadline of 0 as a deadline, not as none", async () => {
    mockDetail(buildCronJob({ startingDeadlineSeconds: 0 }));
    await renderPage();
    expect(
      screen.queryByText(/^none: the latest missed run/)
    ).not.toBeInTheDocument();
  });

  it("flags a CronJob that has fired but never succeeded", async () => {
    mockDetail(buildCronJob({ lastSuccessfulTime: null }));
    await renderPage();
    expect(screen.getByText("no run has succeeded yet")).toBeInTheDocument();
  });

  it("renders nothing when the CronJob is absent and nothing is in flight", async () => {
    mockDetail(undefined);
    const { container } = await renderPage();
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
    await renderPage();
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
    await renderPage();
    expect(
      await screen.findByText("Could not read this CronJob's runs.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/kept · history limits/)).toBeNull();
    expect(screen.queryByText("This CronJob has not run yet")).toBeNull();
    expect(screen.getByRole("tab", { name: /Jobs/ }).textContent).not.toMatch(
      /\d/
    );
  });

  /**
   * The Jobs tab wore "0" while the list of runs was still on its way, a
   * number the read had not given. Fails if a pending list is counted.
   */
  it("wears no number on the Jobs tab while the runs are still being read", async () => {
    vi.mocked(commands.listJobs).mockImplementationOnce(
      () => new Promise(() => {})
    );
    await renderPage();
    expect(screen.getByRole("tab", { name: /Jobs/ }).textContent).not.toMatch(
      /\d/
    );
  });

  /** The other side: a list that was read and is empty says so. */
  it("says on the Jobs tab that a CronJob with no runs has not run", async () => {
    mockDetail(buildCronJob(), "jobs");
    await renderPage();
    expect(
      await screen.findByText("This CronJob has not run yet")
    ).toBeInTheDocument();
    expect(screen.getByText(/0 kept · history limits/)).toBeInTheDocument();
  });

  /**
   * shop/reports read "no run has succeeded yet" above "2 succeeded · 2
   * failed kept": the history limits, worded like counts. Fails if the
   * limits read as runs that happened again.
   */
  it("words the history limits as limits, not as runs", async () => {
    mockDetail(
      buildCronJob({ successfulJobsHistoryLimit: 2, failedJobsHistoryLimit: 2 })
    );
    await renderPage();
    expect(
      await screen.findByText(/keeps the last 2 succeeded and 2 failed runs/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/succeeded · /)).toBeNull();
  });
});

describe("Run now and the access review", () => {
  beforeEach(() =>
    useClusterStore.setState((s) => ({
      currentContext: "prod",
      isConnected: true,
      connectionAttemptId: s.connectionAttemptId + 1,
    }))
  );
  const runNow = () => screen.getByRole("button", { name: "Run now" });

  /**
   * A run is a new Job. Fails if Run now stays live for a reader the cluster
   * refuses create jobs, or if it opens the run dialog anyway.
   */
  it("is greyed with the can-i question where jobs may not be created", async () => {
    mockDetail(buildCronJob());
    vi.mocked(commands.checkAccess).mockImplementation(marcoReview);
    await renderPage();
    await waitFor(() =>
      expect(runNow()).toHaveAttribute("aria-disabled", "true")
    );
    fireEvent.click(runNow());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  /**
   * Run now starts a Job, and its name field is already filled. Fails if
   * the confirmation opens with the focus anywhere but Cancel, or if a stray
   * Enter starts the run.
   */
  it("opens with the cursor on Cancel, so Enter starts no run", async () => {
    mockDetail(buildCronJob({ namespace: "team-checkout" }));
    vi.mocked(commands.checkAccess).mockImplementation(marcoReview);
    await renderPage();
    fireEvent.click(runNow());
    const dialog = await screen.findByRole("alertdialog");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      within(dialog).getByRole("button", { name: "Cancel" })
    ).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(commands.triggerCronjob).not.toHaveBeenCalled();
  });

  /** Marco's Role grants create on jobs in team-checkout. Fails if the guard shuts it. */
  it("stays offered where the review allows it", async () => {
    mockDetail(buildCronJob({ namespace: "team-checkout" }));
    vi.mocked(commands.checkAccess).mockImplementation(marcoReview);
    await renderPage();
    await waitFor(() => expect(commands.checkAccess).toHaveBeenCalled());
    expect(runNow()).not.toHaveAttribute("aria-disabled");
  });
});
