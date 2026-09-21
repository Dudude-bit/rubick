import { describe, expect, it } from "vitest";

import type { CheckOutcome } from "@/generated/types";
import { addressesIn, parseHostPort, verdictOf } from "./checks";

const outcome = (over: Partial<CheckOutcome>): CheckOutcome => ({
  ranIn: "container",
  tried: ["getent"],
  answeredWith: "getent",
  answer: "yes",
  exitCode: 0,
  stdout: "",
  stderr: "",
  elapsedMs: 12,
  copy: null,
  ...over,
});

describe("reading what a person typed", () => {
  it("takes host:port and a bracketed v6 address", () => {
    expect(parseHostPort("postgres:5432")).toEqual({
      host: "postgres",
      port: 5432,
    });
    expect(parseHostPort("[fd00::1]:443")).toEqual({
      host: "fd00::1",
      port: 443,
    });
    expect(parseHostPort("postgres")).toBeNull();
    expect(parseHostPort("postgres:0")).toBeNull();
    expect(parseHostPort("postgres:99999")).toBeNull();
  });
});

describe("reading what the resolver said", () => {
  it("finds the addresses in getent and nslookup output alike", () => {
    expect(
      addressesIn("10.96.12.4     postgres.shop.svc.cluster.local")
    ).toEqual(["10.96.12.4"]);
    expect(
      addressesIn(
        "Server:\t\t10.96.0.10\nAddress:\t10.96.0.10:53\n\nName:\tpostgres.shop.svc.cluster.local\nAddress: 10.96.12.4\n"
      )
    ).toEqual(["10.96.12.4"]);
  });

  /**
   * busybox nslookup exits 0 with "can't resolve" in its output, so a zero
   * exit is not an answer; an address is. Reading the exit alone told a
   * person their name resolved when it did not.
   */
  it("calls a zero exit with no address unresolved", () => {
    const said = verdictOf(
      "dns",
      outcome({
        answeredWith: "nslookup",
        answer: "yes",
        stdout:
          "Server:\t\t10.96.0.10\n\n** server can't find nowhere.shop: NXDOMAIN\n",
      })
    );
    expect(said.says).toBe("notResolved");
  });

  it("names the tools it tried when the image had none", () => {
    const said = verdictOf(
      "tcp",
      outcome({
        answer: "noTool",
        answeredWith: null,
        tried: ["nc", "curl"],
      })
    );
    expect(said).toEqual({ says: "noTool", tried: ["nc", "curl"] });
  });

  it("reads a tcp exit as connected or not", () => {
    expect(verdictOf("tcp", outcome({ answeredWith: "nc" })).says).toBe(
      "connected"
    );
    expect(
      verdictOf(
        "tcp",
        outcome({ answeredWith: "nc", answer: "no", exitCode: 1 })
      ).says
    ).toBe("refused");
  });

  /**
   * `curl telnet://` exits 6 for a name it could not resolve. That is a fact
   * about the name, not about the port, and it was drawn as "does not answer
   * from here" — a refusal the cluster never made.
   */
  it("does not call a port refused when the tool failed for its own reasons", () => {
    const verdict = verdictOf(
      "tcp",
      outcome({ answeredWith: "curl", answer: "unanswered", exitCode: 6 })
    );
    expect(verdict.says).toBe("unanswered");
  });
});

describe("a check that produced no answer at all", () => {
  /**
   * `Exit::ok()` is `code == Some(0)`, and an exec whose status channel
   * never produced one has `code: None` — a dropped websocket, an
   * apiserver that went away mid-exec. Folding that into the negative told
   * the reader "the name does not resolve", a stated fact about the
   * cluster, from a run that produced no fact at all.
   */
  it("does not call a dropped exec a name that does not resolve", () => {
    const verdict = verdictOf(
      "dns",
      outcome({ answer: "unanswered", exitCode: null, stdout: "" })
    );
    expect(verdict.says).toBe("unanswered");
  });

  it("does not call a dropped exec a port that refuses", () => {
    const verdict = verdictOf(
      "tcp",
      outcome({ answer: "unanswered", exitCode: null })
    );
    expect(verdict.says).toBe("unanswered");
  });

  /**
   * And the other half, or the third state would swallow the findings: a
   * resolver that answered and said the name is not there, and a port that
   * answered with a refusal, are both real answers worth stating.
   */
  it("still says a name does not resolve when the resolver said so", () => {
    const verdict = verdictOf(
      "dns",
      outcome({
        answer: "no",
        exitCode: 1,
        stdout: "** server can't find db.shop: NXDOMAIN",
      })
    );
    expect(verdict.says).toBe("notResolved");
  });

  it("still says a port refuses when the tool said so", () => {
    const verdict = verdictOf("tcp", outcome({ answer: "no", exitCode: 7 }));
    expect(verdict.says).toBe("refused");
  });

  /**
   * The case that could not be reached at all: `getent hosts` exits 2 with
   * an empty stdout for a name its resolver does not have, and the rule that
   * read an empty stdout as "nobody answered" made that the verdict on every
   * glibc image — so the panel could say "resolves" and never the opposite.
   */
  it("says a name does not resolve when the rung's own exit said so", () => {
    const verdict = verdictOf(
      "dns",
      outcome({
        answeredWith: "getent",
        answer: "no",
        exitCode: 2,
        stdout: "",
      })
    );
    expect(verdict.says).toBe("notResolved");
  });

  /**
   * And the rule it replaces still holds where the tool said nothing: a
   * getent that fell over for its own reasons is not a name that is absent.
   */
  it("keeps saying nothing when the tool failed for its own reasons", () => {
    const verdict = verdictOf(
      "dns",
      outcome({
        answeredWith: "getent",
        answer: "unanswered",
        exitCode: 1,
        stdout: "",
      })
    );
    expect(verdict.says).toBe("unanswered");
  });
});
