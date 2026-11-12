import { describe, expect, it } from "vite-plus/test";

import { clusterWords } from "./cluster-words";

const code = (text: string) =>
  clusterWords(text)
    .filter((word) => word.kind !== "prose")
    .map((word) => `${word.kind} ${word.text}`);

describe("clusterWords", () => {
  /** Live, this read as one grey wall; fails if the path splits at its camelCase or the value list loses its grammar. */
  it("reads a PodSecurity check's container, field path and value", () => {
    expect(
      code(
        'container "sleeper" must set securityContext.capabilities.drop=["ALL"]'
      )
    ).toEqual([
      'string "sleeper"',
      "key securityContext.capabilities.drop",
      "punct =",
      "punct [",
      'string "ALL"',
      "punct ]",
    ]);
  });

  it("reads a check's name and the value it must not have", () => {
    expect(code("allowPrivilegeEscalation != false")).toEqual([
      "key allowPrivilegeEscalation",
      "punct !=",
      "constant false",
    ]);
  });

  it("reads each key set with = and its value", () => {
    expect(code("requested: pods=1,requests.cpu=500m")).toEqual([
      "key pods",
      "punct =",
      "constant 1",
      "key requests.cpu",
      "punct =",
      "constant 500m",
    ]);
  });

  /** Fails if a URL inside quotes is cut into paths and keys. */
  it("keeps a quoted address whole", () => {
    expect(
      code(
        'Post "https://guard.refused-hook.svc:443/validate?timeout=10s": service "guard" not found'
      )
    ).toEqual([
      'string "https://guard.refused-hook.svc:443/validate?timeout=10s"',
      'string "guard"',
    ]);
  });

  it("reads a label key whole, prefix and all", () => {
    expect(code("its label pod-security.kubernetes.io/enforce")).toEqual([
      "key pod-security.kubernetes.io/enforce",
    ]);
  });

  /** Fails if prose is painted: a sentence's last word, a number, an apostrophe or a capitalised call. */
  it("leaves the scheduler's and the kubelet's prose as prose", () => {
    expect(
      code(
        "0/2 nodes are available: 2 node(s) didn't match pod topology spread constraints. MountVolume.SetUp failed."
      )
    ).toEqual([]);
  });

  /** Fails if a word is lost or doubled between the pieces. */
  it("gives back every character in order", () => {
    const text =
      'pods "web-1" is forbidden: [maximum cpu usage per Container is 500m, but limit is 1]';
    expect(
      clusterWords(text)
        .map((word) => word.text)
        .join("")
    ).toBe(text);
  });
});
