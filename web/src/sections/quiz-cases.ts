/**
 * The six pod fragments the quiz asks about, and the status inspection leaves
 * standing for each.
 *
 * Copied once from `shared/pod-status-conformance.json`, which is the contract
 * between the two evaluators of pod status — Rust for a live pod, TypeScript
 * for a pasted manifest. It is deliberately not imported: that file lives at
 * the repository root, outside this site's Docker build context, and reading it
 * from here would also make a case added for the Rust conformance test change
 * what the marketing site asks visitors.
 */

export type QuizContainer = {
  ready?: boolean;
  state: {
    waiting?: { reason?: string };
    terminated?: { reason?: string; exitCode?: number; signal?: number };
    running?: object;
  };
};

export type QuizCase = {
  name: string;
  expect: string;
  status: { phase: string; containerStatuses: QuizContainer[] };
};

export const QUIZ_CASES: QuizCase[] = [
  {
    name: "a container waiting for a reason names the pod",
    expect: "CrashLoopBackOff",
    status: {
      phase: "Running",
      containerStatuses: [
        {
          ready: false,
          state: {
            waiting: {
              reason: "CrashLoopBackOff",
            },
          },
        },
      ],
    },
  },
  {
    name: "the first container's verdict is the one that stands",
    expect: "ImagePullBackOff",
    status: {
      phase: "Running",
      containerStatuses: [
        {
          ready: false,
          state: {
            waiting: {
              reason: "ImagePullBackOff",
            },
          },
        },
        {
          ready: false,
          state: {
            waiting: {
              reason: "CrashLoopBackOff",
            },
          },
        },
      ],
    },
  },
  {
    name: "a running container leaves the phase standing",
    expect: "Running",
    status: {
      phase: "Running",
      containerStatuses: [
        {
          ready: true,
          state: {
            running: {},
          },
        },
      ],
    },
  },
  {
    name: "a terminated container names its reason",
    expect: "OOMKilled",
    status: {
      phase: "Failed",
      containerStatuses: [
        {
          ready: false,
          state: {
            terminated: {
              exitCode: 137,
              reason: "OOMKilled",
            },
          },
        },
      ],
    },
  },
  {
    name: "a terminated container with no reason names its exit code",
    expect: "ExitCode:2",
    status: {
      phase: "Failed",
      containerStatuses: [
        {
          ready: false,
          state: {
            terminated: {
              exitCode: 2,
            },
          },
        },
      ],
    },
  },
  {
    name: "a container killed by a signal names the signal",
    expect: "Signal:9",
    status: {
      phase: "Failed",
      containerStatuses: [
        {
          ready: false,
          state: {
            terminated: {
              exitCode: 0,
              signal: 9,
            },
          },
        },
      ],
    },
  },
];
