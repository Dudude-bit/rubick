import { describe, expect, it } from "vitest";

import { activityLabel } from "./activity-label";

const none = { ports: 0, terminals: 0, jobs: 0 };

describe("what the activity trigger calls itself", () => {
  it("is a plain invitation when nothing is running", () => {
    expect(activityLabel(none)).toBe("activity");
  });

  /**
   * The reported miss. A user with a port-forward running could not find where
   * to manage it; the trigger read "1 active", which names no thing to look
   * for. Naming it is the whole fix on this line.
   */
  it("names port forwards when they are the only thing running", () => {
    expect(activityLabel({ ...none, ports: 1 })).toBe("1 port forward");
    expect(activityLabel({ ...none, ports: 3 })).toBe("3 port forwards");
  });

  it("names terminals and jobs the same way", () => {
    expect(activityLabel({ ...none, terminals: 1 })).toBe("1 terminal");
    expect(activityLabel({ ...none, terminals: 2 })).toBe("2 terminals");
    expect(activityLabel({ ...none, jobs: 1 })).toBe("1 job");
    expect(activityLabel({ ...none, jobs: 4 })).toBe("4 jobs");
  });

  /** Three nouns do not fit an eleven-pixel status line, so the total wins. */
  it("falls back to a total once two kinds are running", () => {
    expect(activityLabel({ ports: 1, terminals: 2, jobs: 0 })).toBe("3 active");
    expect(activityLabel({ ports: 1, terminals: 1, jobs: 1 })).toBe("3 active");
  });
});
