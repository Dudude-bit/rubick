import { describe, expect, it } from "vitest";

import type { ShellEnvReport } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { shellEnvLine, shellEnvSentence, shellEnvTone } from "./shell-env";

const t: T = (section, key, values) => translate("en", section, key, values);

const OUTCOMES: ShellEnvReport[] = [
  { outcome: "imported", shell: "/bin/zsh", adopted: 3, removed: 1 },
  { outcome: "timedOut", shell: "/bin/zsh", seconds: 30 },
  { outcome: "couldNotStart", shell: "/opt/fish", error: "No such file" },
  { outcome: "noAnswer", shell: "/bin/tcsh", exit: 1 },
  { outcome: "notAsked" },
];

describe("the sentence about the login shell", () => {
  /**
   * Every outcome is a different thing to fix, and the shell is the first
   * thing a reader checks; a sentence that hides either sends them to the
   * wrong file.
   */
  it("names the shell and reads differently for every outcome", () => {
    const sentences = OUTCOMES.map((report) => shellEnvSentence(report, t));
    expect(new Set(sentences).size).toBe(OUTCOMES.length);
    for (const [index, report] of OUTCOMES.entries()) {
      if ("shell" in report) {
        expect(sentences[index]).toContain(report.shell);
      }
    }
  });

  /**
   * Every outcome that leaves the search path a guess has to be drawn as a
   * warning, or the reader checks the directories below one by one and
   * never learns that the list itself is the problem.
   */
  it("warns for every outcome that is not an answer", () => {
    for (const report of OUTCOMES) {
      const tone = shellEnvTone(report);
      if (report.outcome === "imported" || report.outcome === "notAsked") {
        expect(tone).toBe("text-fg-mut");
      } else {
        expect(tone).toBe("text-warn");
      }
    }
  });

  /**
   * A shell killed by a signal has no exit code. Printing `null` would put
   * a programming word on a settings screen; the placeholder has to be
   * filled with something a person reads as "unknown".
   */
  it("does not print null for a shell that died without an exit code", () => {
    const sentence = shellEnvSentence(
      { outcome: "noAnswer", shell: "/bin/zsh", exit: null },
      t
    );
    expect(sentence).not.toContain("null");
    expect(sentence).not.toContain("{exit}");
  });

  /**
   * The two counts are the only numbers on the screen, and they answer
   * different questions: how much the shell changed, and how much it took
   * away. A single "N variables" hid a wipe behind a small number.
   */
  it("carries what changed and what was removed, with the plural right", () => {
    expect(
      shellEnvSentence(
        { outcome: "imported", shell: "/bin/zsh", adopted: 1, removed: 0 },
        t
      )
    ).toContain("1 variable changed, 0 removed");
    expect(
      shellEnvSentence(
        { outcome: "imported", shell: "/bin/zsh", adopted: 57, removed: 2 },
        t
      )
    ).toContain("57 variables changed, 2 removed");
  });

  /**
   * The pasted report is the one screen text that stays English. It has to
   * be the catalogue's English, not a second copy: the next wording fix
   * lands in one place and the other keeps the old sentence otherwise.
   */
  it("prints the catalogue's English in the pasted report", () => {
    for (const report of OUTCOMES) {
      expect(shellEnvLine(report)).toBe(shellEnvSentence(report, t));
    }
  });
});
