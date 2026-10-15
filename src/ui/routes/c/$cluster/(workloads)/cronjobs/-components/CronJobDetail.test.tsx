import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CronJobDetailInfo, JobInfo } from "@/generated/types";

const listeners = vi.hoisted(
  () => ({}) as Record<string, Array<(event: { payload: unknown }) => void>>
);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (event: string, handler: (event: { payload: unknown }) => void) => {
      (listeners[event] ??= []).push(handler);
      return () => {
        listeners[event] = (listeners[event] ?? []).filter(
          (h) => h !== handler
        );
      };
    }
  ),
  emit: vi.fn(async () => {}),
  once: vi.fn(async () => () => {}),
}));

vi.mock("@/hooks", () => ({
  useResourceDetail: vi.fn(),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    getCronjob: vi.fn(async () => buildCronJob()),
    deleteCronjob: vi.fn(),
    listJobs: vi.fn(async () => []),
    listPods: vi.fn(async () => []),
    listEvents: vi.fn(async () => []),
    triggerCronjob: vi.fn(async () => "nightly-backup-1"),
    checkAccess: vi.fn(),
    subscribeJobWatch: vi.fn(async () => "jobs-1"),
    resourceWatchSubscribed: vi.fn(async () => undefined),
    unsubscribeResourceWatch: vi.fn(async () => undefined),
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

function run(name: string, status: string): JobInfo {
  return {
    name,
    namespace: "ops",
    uid: "run",
    completions: 1,
    succeeded: status === "Complete" ? 1 : 0,
    failed: 0,
    active: status === "Running" ? 1 : 0,
    status,
    failure: null,
    createdAt: new Date().toISOString(),
  };
}

const ownedByRun = {
  apiVersion: "batch/v1",
  kind: "Job",
  name: "nightly-backup-29000000",
  uid: "run",
  controller: true,
};

const usageSection = async () =>
  (await screen.findByText("Usage")).closest("section") as HTMLElement;

function renderPage() {
  return renderWithRouter(<CronJobDetail />, {
    at: "/c/prod/cronjobs/ops/nightly-backup",
    route: "/c/$cluster/cronjobs/$namespace/$name",
  });
}

describe("CronJobDetail", () => {
  beforeEach(() => mockDetail(buildCronJob()));

  /**
   * Live, reports' page said "Last run 1m ago" and "no run has succeeded yet"
   * for six days and never why. Fails if the page does not lead with the
   * cause its newest run's pods share.
   */
  it("leads with the cause its newest run's pods share", async () => {
    vi.mocked(commands.listJobs).mockResolvedValueOnce([
      run("nightly-backup-29000000", "Failed"),
    ]);
    vi.mocked(commands.listPods).mockResolvedValue([
      {
        name: "nightly-backup-29000000-x",
        namespace: "ops",
        uid: "pod-x",
        status: {
          phase: "Failed",
          display: "Error",
          ready: false,
          cause: {
            says: "exits",
            container: "backup",
            restarts: 0,
            run: {
              code: 2,
              signal: null,
              reason: "Error",
              started: null,
              ended: null,
              previous: false,
              said: null,
              log: { says: "notRead" },
              limit: null,
            },
            until: null,
          },
        },
        containers: [],
        ownerReferences: [ownedByRun],
      } as never,
    ]);
    await renderPage();
    expect(await screen.findByTestId("pods-cause")).toHaveTextContent(
      "In its last run, Job nightly-backup-29000000, 1 of 1 pod: backup exited (exit 2, Error)."
    );
    vi.mocked(commands.listPods).mockResolvedValue([]);
  });

  /**
   * A quota refused every pod its run asked for, so no pod was there to say
   * why and the page said nothing. Fails if the last run's cause does not
   * quote the API server's refusal of that run's pods, or the runs bar does
   * not count the run as refused.
   */
  it("leads with the API server's refusal of its newest run's pods", async () => {
    const said =
      'Error creating: pods "nightly-backup-29000000-x" is forbidden: exceeded quota: two-pods';
    vi.mocked(commands.listJobs).mockResolvedValueOnce([
      run("nightly-backup-29000000", "Pending"),
    ]);
    vi.mocked(commands.listEvents).mockResolvedValue([
      {
        name: "e",
        namespace: "ops",
        uid: "e",
        type: "Warning",
        reason: "FailedCreate",
        message: said,
        source: "job-controller",
        involvedObject: {
          kind: "Job",
          name: "nightly-backup-29000000",
          namespace: "ops",
          uid: "run",
        },
        count: 3,
        firstTimestamp: null,
        lastTimestamp: new Date().toISOString(),
      },
    ]);
    useClusterStore.setState({ currentContext: "prod", isConnected: true });
    await renderPage();
    expect(await screen.findByTestId("refused-line")).toHaveTextContent(
      `In its last run, Job nightly-backup-29000000, The API server refuses to create its pods. The API server answered: ${said}`
    );
    expect(
      await screen.findByText("1 with its pods refused")
    ).toBeInTheDocument();
    const lastRun = (await screen.findByText("Last run")).nextElementSibling;
    expect(lastRun).toHaveClass("text-err");
    expect(lastRun).toHaveTextContent(/ago · not started$/);
    expect(await usageSection()).toHaveTextContent(
      "Its run in flight, nightly-backup-29000000, has no pod: the API server refuses to create them."
    );
    expect(screen.getByText("Next run").parentElement).toHaveTextContent(
      "skipped: Job nightly-backup-29000000 cannot end while its pods are refused, and the concurrency policy is Forbid"
    );
    expect(screen.getByText("Next run").nextElementSibling).toHaveClass(
      "text-err"
    );
    vi.mocked(commands.listEvents).mockResolvedValue([]);
  });

  /**
   * The runs bar counted only running, succeeded, retrying and failed runs,
   * so a run kept and not yet started read "1 job kept" over "nothing
   * scheduled". Fails if a kept run is left out of the bar.
   */
  it("counts a run that has not started in its runs bar", async () => {
    vi.mocked(commands.listJobs).mockResolvedValueOnce([
      run("nightly-backup-29000000", "Pending"),
    ]);
    useClusterStore.setState({ currentContext: "prod", isConnected: true });
    await renderPage();
    expect(await screen.findByText("1 not started")).toBeInTheDocument();
    expect(screen.queryByText("nothing scheduled")).toBeNull();
  });

  /**
   * The headline was amber only while no run had ever succeeded, so a CronJob
   * that succeeded once and then failed every run read as fine. Fails if a
   * success older than its last run keeps the headline neutral, or a success
   * of its own last run paints it.
   */
  it("reds its last run when that run did not succeed, whatever succeeded before", async () => {
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    mockDetail(
      buildCronJob({
        lastSchedule: hourAgo,
        lastSuccessfulTime: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      })
    );
    const failing = await renderPage();
    const value = (await screen.findByText("Last run")).nextElementSibling;
    expect(value).toHaveClass("text-err");
    failing.unmount();

    mockDetail(
      buildCronJob({ lastSchedule: hourAgo, lastSuccessfulTime: hourAgo })
    );
    await renderPage();
    expect(
      (await screen.findByText("Last run")).nextElementSibling
    ).not.toHaveClass("text-err");
  });

  it("leads with the schedule, in cron and in words", async () => {
    await renderPage();
    expect(screen.getByText("0 3 * * *")).toBeInTheDocument();
    expect(screen.getByText(/daily at 03:00/)).toBeInTheDocument();
  });

  it("answers when it last ran and when it runs next", async () => {
    await renderPage();
    expect(screen.getByText("Last run")).toBeInTheDocument();
    expect(screen.getByText("1h ago · succeeded")).toBeInTheDocument();
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

  /** A read with no answer yet drew a blank pane; fails if it draws anything but the placeholder. */
  it("draws its placeholder while no read of the CronJob has answered", async () => {
    mockDetail(undefined);
    await renderPage();
    expect(screen.getByTestId("detail-skeleton")).toBeInTheDocument();
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
   * Dana's cron-demo Usage read "still reading" for more than ten seconds
   * between runs: the pods are asked for only while a run is in flight, and
   * the read nobody started counted as one under way. Fails if a CronJob
   * the controller and its Jobs both call idle waits on a read for it.
   */
  it("says nothing is running between runs without waiting on a read", async () => {
    vi.mocked(commands.listJobs).mockResolvedValueOnce([
      run("nightly-backup-29863555", "Complete"),
    ]);
    await renderPage();
    const usage = await usageSection();
    expect(usage).toHaveTextContent("nothing running");
    expect(usage).toHaveTextContent("No run of this CronJob is in flight.");
    expect(usage).not.toHaveTextContent("still reading");
    expect(commands.listPods).not.toHaveBeenCalled();
  });

  /** A Job still running is a run in flight, whatever the controller's count says; fails if its pods go unasked. */
  it("reads the pods of a run a Job it holds says is running", async () => {
    vi.mocked(commands.listJobs).mockResolvedValueOnce([
      run("nightly-backup-29863560", "Running"),
    ]);
    // The newest run's own pods are read apart, for its cause.
    vi.mocked(commands.listPods).mockImplementation(async (filters) =>
      filters?.labelSelector ? [] : new Promise(() => {})
    );
    await renderPage();
    await waitFor(() =>
      expect(commands.listPods).toHaveBeenCalledWith(
        expect.objectContaining({ labelSelector: null })
      )
    );
    const usage = await usageSection();
    expect(usage).toHaveTextContent("still reading");
    expect(usage).not.toHaveTextContent("nothing running");
    vi.mocked(commands.listPods).mockResolvedValue([]);
  });

  /**
   * Live, root-cron's Usage said "No run of this CronJob is in flight" beside
   * Active jobs 1. Fails if a run in flight with no pod is called no run.
   */
  it("says its run in flight has no pod yet rather than that no run is in flight", async () => {
    vi.mocked(commands.listJobs).mockResolvedValueOnce([
      run("nightly-backup-29863560", "Running"),
    ]);
    await renderPage();
    await waitFor(async () =>
      expect(await usageSection()).toHaveTextContent(
        "Its run in flight, nightly-backup-29863560, has no pod running yet."
      )
    );
    expect(await usageSection()).not.toHaveTextContent(
      "No run of this CronJob is in flight."
    );
  });

  /**
   * Dana's cron-demo: right after a run "Next run" had moved on while "Last
   * run" still said the old time, until the CronJob was polled again. Fails
   * if a run the page holds, newer than the CronJob's own last schedule,
   * does not date "Last run".
   */
  it("dates the last run by the newest run it holds when the CronJob's status trails", async () => {
    const minute = Math.floor((Date.now() - 2 * 60_000) / 60_000);
    vi.mocked(commands.listJobs).mockResolvedValueOnce([
      run(`nightly-backup-${minute}`, "Running"),
    ]);
    await renderPage();
    const last = (await screen.findByText("Last run")).parentElement!;
    await waitFor(() => expect(last).toHaveTextContent("2m ago"));
    expect(last).not.toHaveTextContent("1h ago");
  });

  /**
   * nightly-export said "nothing running, last run 3m ago" for the eight
   * seconds kubectl showed its Job running: the runs were polled. Fails if a
   * change to one of this CronJob's Jobs does not read its runs again at
   * once, or if another CronJob's Job does.
   */
  it("reads its runs again when one of its Jobs changes, and not for another's", async () => {
    useClusterStore.setState({ currentContext: "prod", isConnected: true });
    await renderPage();
    await waitFor(() =>
      expect(commands.resourceWatchSubscribed).toHaveBeenCalledWith("jobs-1")
    );
    await waitFor(() => expect(commands.listJobs).toHaveBeenCalled());
    const send = (name: string) =>
      act(() => {
        for (const heard of listeners["resource-event"] ?? [])
          heard({
            payload: {
              stream_id: "jobs-1",
              changes: [{ op: "applied", resource: run(name, "Running") }],
              error: null,
            },
          });
      });
    send("restarted-elsewhere-1");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = vi.mocked(commands.listJobs).mock.calls.length;
    send("nightly-backup-29863734");
    await waitFor(() =>
      expect(vi.mocked(commands.listJobs).mock.calls.length).toBeGreaterThan(
        before
      )
    );
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
