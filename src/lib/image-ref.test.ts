import { describe, it, expect } from "vitest";

import { parseImageRef } from "./image-ref";

describe("parseImageRef", () => {
  it("splits the shapes the cluster actually runs", () => {
    expect(parseImageRef("busybox")).toEqual({
      reference: "busybox",
      registry: null,
      repository: "busybox",
      tag: null,
      digest: null,
    });
    expect(parseImageRef("busybox:1.36")).toMatchObject({
      registry: null,
      repository: "busybox",
      tag: "1.36",
    });
    expect(parseImageRef("registry.invalid/nope:v9")).toMatchObject({
      registry: "registry.invalid",
      repository: "nope",
      tag: "v9",
    });
    expect(parseImageRef("nginx:1.27-alpine")).toMatchObject({
      repository: "nginx",
      tag: "1.27-alpine",
    });
  });

  it("keeps a registry port out of the tag", () => {
    expect(parseImageRef("localhost:5000/app:v1")).toMatchObject({
      registry: "localhost:5000",
      repository: "app",
      tag: "v1",
    });
    expect(parseImageRef("localhost:5000/app")).toMatchObject({
      registry: "localhost:5000",
      repository: "app",
      tag: null,
    });
  });

  it("reads a multi-segment path and a digest", () => {
    const digest = `sha256:${"a1b2c3d4".repeat(8)}`;
    expect(parseImageRef(`gcr.io/project/sub/app@${digest}`)).toMatchObject({
      registry: "gcr.io",
      repository: "project/sub/app",
      tag: null,
      digest,
    });
    expect(parseImageRef(`ghcr.io/owner/app:v2@${digest}`)).toMatchObject({
      registry: "ghcr.io",
      repository: "owner/app",
      tag: "v2",
      digest,
    });
  });

  it("treats a dotless first segment as repository, not registry", () => {
    // `library/busybox` is Docker Hub's namespace, not a host.
    expect(parseImageRef("library/busybox:latest")).toMatchObject({
      registry: null,
      repository: "library/busybox",
      tag: "latest",
    });
  });

  it("refuses what is not a reference", () => {
    for (const input of [
      "",
      "12:34:56", // a clock time
      "Back-off pulling image", // a sentence
      "busybox 1.36", // whitespace
      "UPPER/case:v1", // a repository path may not carry upper case
      "busybox:", // an empty tag
      "busybox@sha256:abc", // a digest too short to be one
      "busybox@notadigest",
      "-leading/dash",
    ]) {
      expect(parseImageRef(input), input).toBeNull();
    }
  });

  it("is a grammar, not a detector", () => {
    // These are legal references, and the parser says so. Refusing prose is
    // `linkifyMessage`'s job — which is why it never runs the grammar over a
    // sentence, only over what the sentence labelled as an image.
    expect(parseImageRef("ratio:0.82")).not.toBeNull();
    expect(parseImageRef("10.42.0.6:8080")).not.toBeNull();
  });
});
