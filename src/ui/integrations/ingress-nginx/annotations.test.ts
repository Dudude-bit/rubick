import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { describe, expect, it } from "vitest";

/** The English catalogue — what these expectations are written in. */
const t: T = (section, key, values) => translate("en", section, key, values);

import {
  PREFIX,
  rawNote,
  TABLE_SIZE,
  readAnnotation,
  readAnnotations,
} from "./annotations";

const key = (suffix: string) => `${PREFIX}${suffix}`;

/**
 * The annotations off a real Ingress, copied rather than invented: this is
 * the shape the app is claiming it can read, and a table tested against
 * strings written to make it pass tests nothing.
 */
const REAL: Record<string, string> = {
  [key("ssl-redirect")]: "true",
  [key("proxy-body-size")]: "50m",
  [key("rewrite-target")]: "/$2",
  [key("use-regex")]: "true",
  [key("proxy-read-timeout")]: "3600",
  [key("proxy-connect-timeout")]: "10",
  [key("whitelist-source-range")]: "10.0.0.0/8,192.168.0.0/16",
  [key("auth-type")]: "basic",
  [key("auth-secret")]: "shop-basic-auth",
  [key("auth-realm")]: "Staging only",
  [key("configuration-snippet")]: "more_set_headers 'X-Env: staging';",
  [key("mirror-target")]: "https://mirror.k8s-gui.test/$request_uri",
  "kubectl.kubernetes.io/last-applied-configuration": "{}",
};

describe("the table", () => {
  /**
   * Would break if the table shrank to the point where the common Ingress
   * stopped being readable. Twelve keys is what the design's example
   * carries, and a table that decoded three of them would be a feature
   * nobody could tell was on.
   */
  it("says something about every common key on a real Ingress", () => {
    const readings = readAnnotations(REAL, t);
    const said = readings.filter((reading) => reading.said !== null);
    expect(said).toHaveLength(10);
    expect(TABLE_SIZE).toBeGreaterThanOrEqual(40);
  });

  /** Would break if a non-nginx annotation started being read as one. */
  it("looks at nginx's keys and nothing else", () => {
    const readings = readAnnotations(REAL, t);
    expect(readings).toHaveLength(12);
    expect(readings.every((reading) => reading.key.startsWith(PREFIX))).toBe(
      true
    );
  });

  /**
   * Would break if the sentences drifted from what nginx does. Each of
   * these is the behaviour a reader is deciding something on.
   */
  it("decodes them into what nginx actually does", () => {
    const by = new Map(
      readAnnotations(REAL, t).map((reading) => [reading.key, reading.said])
    );
    expect(by.get(key("ssl-redirect"))).toBe(
      "Plain HTTP is answered with a redirect to HTTPS."
    );
    expect(by.get(key("proxy-body-size"))).toBe(
      "A request body larger than 50m is refused with 413."
    );
    expect(by.get(key("rewrite-target"))).toBe(
      "The path is rewritten to /$2 before the backend sees it."
    );
    expect(by.get(key("proxy-read-timeout"))).toContain("3600 seconds");
    expect(by.get(key("whitelist-source-range"))).toBe(
      "Only clients in 10.0.0.0/8, 192.168.0.0/16 are served; every other address is refused with 403."
    );
    expect(by.get(key("auth-secret"))).toContain("shop-basic-auth");
  });

  /**
   * The rule the whole file exists for. A snippet is raw nginx config and is
   * never paraphrased at any confidence — this would break the moment
   * somebody added a table entry for one, which is the mistake rather than
   * the fix.
   */
  it("never paraphrases a snippet, and says it is raw nginx config", () => {
    const snippet = readAnnotation(
      key("configuration-snippet"),
      "more_set_headers 'X-Env: staging';",
      t
    );
    expect(snippet.said).toBeNull();
    expect(snippet.raw).toBe("snippet");
    expect(snippet.value).toBe("more_set_headers 'X-Env: staging';");
    expect(rawNote("snippet", t)).toContain("verbatim");

    for (const suffix of [
      "server-snippet",
      "modsecurity-snippet",
      "stream-snippet",
    ]) {
      expect(readAnnotation(key(suffix), "deny all;", t).raw).toBe("snippet");
    }
  });

  /**
   * The other half of the same rule: around ninety of these annotations
   * exist and the table holds the ones worth a sentence. A key it has never
   * heard of is printed, not guessed at.
   */
  it("shows a key it has no sentence for as written", () => {
    const unknown = readAnnotation(
      key("mirror-target"),
      "https://mirror.k8s-gui.test/$request_uri",
      t
    );
    expect(unknown.said).toBeNull();
    expect(unknown.raw).toBe("notInTheTable");
    expect(unknown.value).toBe("https://mirror.k8s-gui.test/$request_uri");
  });

  /**
   * Would break if a known key with a value the app cannot parse started
   * getting a confident sentence. `proxy-body-size: enormous` is not 413 at
   * some size this app invented.
   */
  it("refuses a value it knows the key of and cannot read", () => {
    expect(readAnnotation(key("proxy-body-size"), "enormous", t).raw).toBe(
      "unreadableValue"
    );
    expect(readAnnotation(key("proxy-read-timeout"), "1h", t).raw).toBe(
      "unreadableValue"
    );
    expect(readAnnotation(key("ssl-redirect"), "yes", t).raw).toBe(
      "unreadableValue"
    );
    expect(readAnnotation(key("backend-protocol"), "SOMETHING", t).raw).toBe(
      "unreadableValue"
    );
    expect(readAnnotation(key("auth-type"), "oauth", t).raw).toBe(
      "unreadableValue"
    );
  });

  /** Would break if the raw key stopped travelling with the sentence. */
  it("keeps the raw key beside every line, decoded or not", () => {
    for (const reading of readAnnotations(REAL, t)) {
      expect(reading.key).toMatch(/^nginx\.ingress\.kubernetes\.io\//);
      expect(typeof reading.value).toBe("string");
      expect(reading.said === null).toBe(reading.raw !== null);
    }
  });

  /** A snippet is the longest line and the one that must be read in full. */
  it("puts the snippets last", () => {
    const readings = readAnnotations(REAL, t);
    expect(readings[readings.length - 1].raw).toBe("snippet");
  });
});

describe("canary", () => {
  /** Would break if a canary stopped reading as a share of one host. */
  it("reads a weight as a share of the host it shadows", () => {
    const canary = {
      [key("canary")]: "true",
      [key("canary-weight")]: "20",
    };
    const by = new Map(
      readAnnotations(canary, t).map((reading) => [reading.key, reading.said])
    );
    expect(by.get(key("canary"))).toContain(
      "a host another Ingress already serves"
    );
    expect(by.get(key("canary-weight"))).toBe(
      "20% of this host's requests take this route instead of the one it shadows."
    );
  });

  /**
   * Would break if a non-default `canary-weight-total` were still read as a
   * percentage — 20 out of 1000 is 2%, and calling it 20% is off by a
   * factor of ten in the direction that matters.
   */
  it("stops saying percent when the total is not a hundred", () => {
    const canary = {
      [key("canary")]: "true",
      [key("canary-weight")]: "20",
      [key("canary-weight-total")]: "1000",
    };
    const weight = readAnnotations(canary, t).find(
      (reading) => reading.key === key("canary-weight")
    );
    expect(weight?.said).toBe(
      "20 of every 1000 requests for this host take this route instead of the one it shadows."
    );
  });

  /**
   * Would break if the header rule stopped naming its own header — the
   * value key is meaningless without it, and nginx checks it before any
   * weight.
   */
  it("names the header a by-header-value rule is about", () => {
    const canary = {
      [key("canary")]: "true",
      [key("canary-by-header")]: "X-Canary",
      [key("canary-by-header-value")]: "please",
    };
    const by = new Map(
      readAnnotations(canary, t).map((reading) => [reading.key, reading.said])
    );
    expect(by.get(key("canary-by-header-value"))).toBe(
      "A request whose X-Canary header is exactly please takes this route."
    );
    expect(by.get(key("canary-by-header"))).toContain("before any weight");
  });

  /** Would break if a value key with no header to belong to were invented. */
  it("refuses a by-header-value with no header named", () => {
    const orphan = { [key("canary-by-header-value")]: "please" };
    expect(readAnnotations(orphan, t)[0].raw).toBe("unreadableValue");
  });
});
