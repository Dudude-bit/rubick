/**
 * Background Job Store
 *
 * Tracks background operations like delete, scale, restart, etc.
 * Jobs are displayed in the Activity Panel and can be used
 * to show progress and results of async operations.
 *
 * @module stores/backgroundJobStore
 */

import { create } from "zustand";

export type BackgroundJobType =
  | "delete"
  | "scale"
  | "restart"
  | "apply"
  | "rollback"
  | "cordon"
  | "uncordon"
  | "drain";

export type BackgroundJobStatus =
  "pending" | "running" | "completed" | "failed";

/**
 * Background job entry
 *
 * Represents an async operation running in the background.
 */
export interface BackgroundJob {
  /** Unique job identifier */
  id: string;
  /** Type of operation */
  type: BackgroundJobType;
  /** Kubernetes resource type (e.g., "Pod", "Deployment") */
  resourceType: string;
  /** Resource name */
  resourceName: string;
  /** Resource namespace (if applicable) */
  namespace?: string;
  /** Kubernetes context */
  context?: string;
  /** Current job status */
  status: BackgroundJobStatus;
  /** Status message or error description */
  message?: string;
  /** Progress percentage (0-100) for long operations */
  progress?: number;
  /** ISO timestamp when job was created */
  createdAt: string;
  /** ISO timestamp when job completed */
  completedAt?: string;
}

interface BackgroundJobState {
  /** All background jobs (recent history) */
  jobs: BackgroundJob[];

  /**
   * Add a new background job
   * Returns the job ID for tracking
   */
  addJob: (
    job: Omit<BackgroundJob, "id" | "createdAt" | "status"> & {
      status?: BackgroundJobStatus;
    }
  ) => string;

  /**
   * Update an existing job
   */
  updateJob: (
    id: string,
    updates: Partial<Omit<BackgroundJob, "id" | "createdAt">>
  ) => void;

  /**
   * Mark a job as completed
   */
  completeJob: (id: string, message?: string) => void;

  /**
   * Mark a job as failed
   */
  failJob: (id: string, error: string) => void;

  /**
   * Remove a job by ID
   */
  removeJob: (id: string) => void;

  /**
   * Clear all completed and failed jobs
   */
  clearCompleted: () => void;

  /**
   * Clear all jobs
   */
  clearAll: () => void;

  /**
   * Get active (pending/running) jobs
   */
  getActiveJobs: () => BackgroundJob[];

  /**
   * Get active jobs count
   */
  getActiveCount: () => number;
}

// Keep last N jobs in history
const MAX_JOB_HISTORY = 50;

function generateJobId(): string {
  return `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useBackgroundJobStore = create<BackgroundJobState>((set, get) => ({
  jobs: [],

  addJob: (job) => {
    const id = generateJobId();
    const entry: BackgroundJob = {
      ...job,
      id,
      status: job.status ?? "pending",
      createdAt: new Date().toISOString(),
    };

    set((state) => ({
      // Add new job at the beginning, limit history
      jobs: [entry, ...state.jobs].slice(0, MAX_JOB_HISTORY),
    }));

    return id;
  },

  updateJob: (id, updates) => {
    set((state) => ({
      jobs: state.jobs.map((job) =>
        job.id === id ? { ...job, ...updates } : job
      ),
    }));
  },

  completeJob: (id, message) => {
    set((state) => ({
      jobs: state.jobs.map((job) =>
        job.id === id
          ? {
              ...job,
              status: "completed" as const,
              message,
              completedAt: new Date().toISOString(),
            }
          : job
      ),
    }));
  },

  failJob: (id, error) => {
    set((state) => ({
      jobs: state.jobs.map((job) =>
        job.id === id
          ? {
              ...job,
              status: "failed" as const,
              message: error,
              completedAt: new Date().toISOString(),
            }
          : job
      ),
    }));
  },

  removeJob: (id) => {
    set((state) => ({
      jobs: state.jobs.filter((job) => job.id !== id),
    }));
  },

  clearCompleted: () => {
    set((state) => ({
      jobs: state.jobs.filter(
        (job) => job.status !== "completed" && job.status !== "failed"
      ),
    }));
  },

  clearAll: () => {
    set({ jobs: [] });
  },

  getActiveJobs: () => {
    return get().jobs.filter(
      (job) => job.status === "pending" || job.status === "running"
    );
  },

  getActiveCount: () => {
    return get().jobs.filter(
      (job) => job.status === "pending" || job.status === "running"
    ).length;
  },
}));
