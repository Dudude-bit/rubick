import { describe, expect, it } from "vite-plus/test";

import type { EndedRun, PodCause } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import {
  causeText,
  causeWords,
  currentCause,
  exitMeaning,
  tellingLine,
} from "@/lib/pod-cause";

const t: T = (section, key, values) => translate("en", section, key, values);
const ru: T = (section, key, values) => translate("ru", section, key, values);

function run(over: Partial<EndedRun> = {}): EndedRun {
  return {
    code: 1,
    signal: null,
    reason: "Error",
    started: "2026-10-12T10:00:00Z",
    ended: "2026-10-12T10:00:03Z",
    previous: true,
    said: null,
    log: { says: "notRead" },
    limit: null,
    ...over,
  };
}

const exits = (
  ended: EndedRun | null,
  until: string | null = null
): PodCause => ({
  says: "exits",
  container: "api",
  restarts: 7,
  run: ended,
  until,
});

describe("exitMeaning", () => {
  /** Each standard exit has its own meaning. Fails if one is dropped or swapped for another. */
  it.each([
    [{ code: 0, reason: "Completed" }, "finished successfully"],
    [{ code: 126 }, "cannot be run"],
    [{ code: 127 }, "was not found in the image"],
    [{ code: 137 }, "SIGKILL"],
    [{ code: 139 }, "segmentation fault"],
    [{ code: 143 }, "SIGTERM"],
    [{ code: 134 }, "SIGABRT"],
    [{ code: 130 }, "signal 2"],
    [{ code: 0, signal: 9 }, "SIGKILL"],
  ])("reads %o as %s", (over, meaning) => {
    expect(exitMeaning(run(over), t)).toContain(meaning);
  });

  /** An OOM kill is measured against the container's limit. Fails if the limit is dropped, or invented where none is declared. */
  it("measures an OOM kill against the limit, and says when there is none", () => {
    const oom = { code: 137, reason: "OOMKilled" };
    expect(exitMeaning(run({ ...oom, limit: "256Mi" }), t)).toBe(
      "killed for using more memory than its 256Mi limit"
    );
    expect(exitMeaning(run(oom), t)).toContain("no limit of its own");
  });

  /** Exit 1 is the app's own: the meaning is its message, which the cause quotes. */
  it("leaves exit 1 to the app's own words", () => {
    expect(exitMeaning(run(), t)).toBeNull();
  });
});

describe("causeWords", () => {
  /**
   * shop/checkout: the headline was "CrashLoopBackOff, 7 restarts". Fails
   * if the exit, its run time or the app's own message stops leading.
   */
  it("leads with the exit, how long it ran and the app's message", () => {
    const words = causeWords(
      exits(
        run({
          said: "starting\nError: couldn't find key DB_PASSWORD in Secret checkout-db\n",
        })
      ),
      t
    );
    expect(words.sentence).toBe("api exited (exit 1, Error), after running 3s");
    expect(words.quote).toEqual({
      label: "Its exit message:",
      text: "Error: couldn't find key DB_PASSWORD in Secret checkout-db",
    });
    expect(words.tone).toBe("err");
  });

  /** The meaning goes into the sentence in both languages; the kubelet's word stays as written. */
  it("puts the meaning in the sentence and keeps OOMKilled untranslated", () => {
    const oom = exits(run({ code: 137, reason: "OOMKilled", limit: "256Mi" }));
    expect(causeText(oom, t)).toContain(
      "exit 137, OOMKilled): killed for using more memory than its 256Mi limit"
    );
    expect(causeText(oom, ru)).toContain("OOMKilled");
    expect(causeText(oom, ru)).toContain("256Mi");
  });

  /** A log the reader could not read is said as such. Fails if a refused or gone log reads as an empty one. */
  it("says why the log is missing rather than nothing", () => {
    const refused = causeWords(exits(run({ log: { says: "refused" } })), t);
    expect(refused.note).toBe("Its log is not readable with this access.");
    const gone = causeWords(exits(run({ log: { says: "gone" } })), t);
    expect(gone.note).not.toBe(refused.note);
    expect(gone.note).toBeTruthy();
  });

  /** The kubelet reported no exit: the sentence says so instead of inventing one. */
  it("says the exit was not reported where there is no run", () => {
    expect(causeWords(exits(null), t).sentence).toContain(
      "did not report how its last run ended"
    );
  });
});

describe("tellingLine", () => {
  /** A panic's last line is a stack frame. Fails if the frame is quoted over the line that says why. */
  it("skips frames and sign-offs to the line that says why", () => {
    const text = [
      "panic: dial tcp 10.0.0.5:5432: connect: connection refused",
      "",
      "goroutine 1 [running]:",
      "main.main()",
      "\t/app/main.go:12 +0x1d",
      "exit status 2",
    ].join("\n");
    expect(tellingLine(text)).toEqual({
      text: "panic: dial tcp 10.0.0.5:5432: connect: connection refused",
      last: false,
    });
  });
});

describe("currentCause", () => {
  /** An exit a container has been up since stops counting. Fails if it lingers past its until, or ends early. */
  it("drops an exit past its until and keeps one before", () => {
    const cause = exits(run(), "2026-10-12T11:00:00Z");
    expect(currentCause(cause, Date.parse("2026-10-12T11:00:01Z"))).toBeNull();
    expect(currentCause(cause, Date.parse("2026-10-12T10:59:59Z"))).toBe(cause);
  });
});

describe("a pod that runs and is not Ready", () => {
  const notReady = (
    probe: Extract<PodCause, { says: "notReady" }>["probe"]
  ): PodCause => ({
    says: "notReady",
    containers: ["web"],
    since: new Date(Date.now() - 12 * 60_000).toISOString(),
    probe,
  });

  /** Fails if the readiness probe stops being quoted, or the time out of its Services stops being said. */
  it("says how long it has been out and quotes the probe", () => {
    const words = causeWords(
      notReady({ says: "http", scheme: "HTTP", path: "/ready", port: "8080" }),
      t
    );
    expect(words.sentence).toBe(
      "web runs but has not been Ready for 12m, so its Services leave it out"
    );
    expect(words.quote).toEqual({
      label: "Its readiness probe:",
      text: "GET /ready on port 8080",
    });
    expect(words.tone).toBe("warn");
  });

  /** No probe is said as no probe. Fails if a missing probe reads as a failing one. */
  it("says there is no readiness probe where none is declared", () => {
    const words = causeWords(notReady(null), t);
    expect(words.quote).toBeNull();
    expect(words.note).toContain("no readiness probe");
  });

  /** Not-ready has no exit, so nothing expires it. */
  it("stays current whatever the time", () => {
    const cause = notReady(null);
    expect(currentCause(cause, Date.now() + 86_400_000)).toBe(cause);
  });
});
