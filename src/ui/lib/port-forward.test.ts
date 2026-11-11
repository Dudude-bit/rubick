import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { forwardNoteWords, suggestedLocalPort } from "./port-forward";

const t: T = (section, key, values) => translate("en", section, key, values);

describe("the local port a forward offers", () => {
  /** Below 1024 needs root on Linux and macOS: 80 seeded 80 and failed. */
  it("lifts a privileged port to the number people already type", () => {
    expect(suggestedLocalPort(80, new Set())).toBe(8080);
    expect(suggestedLocalPort(443, new Set())).toBe(8443);
  });

  it("keeps a port a normal user may listen on", () => {
    expect(suggestedLocalPort(5432, new Set())).toBe(5432);
  });

  /** Two forwards to two pods on 80 must not both offer 8080. */
  it("steps past a port this app is already forwarding", () => {
    expect(suggestedLocalPort(80, new Set([8080, 8081]))).toBe(8082);
  });
});

describe("what a forward's row says of its pod", () => {
  /**
   * A StatefulSet pod back under its name and starting kept the row at "was
   * deleted; waiting for a ready pod". Fails if the note for a pod that is
   * back has no words, or the words of one that is gone.
   */
  it("says a pod back under its name is starting, not deleted", () => {
    expect(forwardNoteWords({ says: "starting", pod: "api-0" }, t)).toBe(
      "pod api-0 is back and starting; waiting for it to be up"
    );
  });
});
