import { describe, it, expect } from "vitest";

import { parseImageRef, registryLink } from "./image-ref";

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

const link = (image: string) => registryLink(parseImageRef(image));

describe("registryLink", () => {
  // Every URL here was fetched before it was written down; the status each
  // returned is in the commit that added them. A wrong shape is not a typo,
  // it is a reader sent to a 404 by the app.
  const opens: [image: string, url: string, site: string, name: string][] = [
    // An official image is `_/name`, and `library/name` is the same image
    // spelled out — both must land in the same place.
    ["nginx", "https://hub.docker.com/_/nginx", "Docker Hub", "nginx"],
    ["library/nginx", "https://hub.docker.com/_/nginx", "Docker Hub", "nginx"],
    [
      "docker.io/library/busybox:1.36",
      "https://hub.docker.com/_/busybox/tags?name=1.36",
      "Docker Hub",
      "busybox:1.36",
    ],
    [
      "index.docker.io/busybox",
      "https://hub.docker.com/_/busybox",
      "Docker Hub",
      "busybox",
    ],
    // A namespaced repository is `r/ns/name`, a different path entirely.
    [
      "rancher/mirrored-pause:3.6",
      "https://hub.docker.com/r/rancher/mirrored-pause/tags?name=3.6",
      "Docker Hub",
      "rancher/mirrored-pause:3.6",
    ],
    [
      "quay.io/prometheus/prometheus:v2.45.0",
      "https://quay.io/repository/prometheus/prometheus?tab=tags&tag=v2.45.0",
      "Quay",
      "prometheus/prometheus:v2.45.0",
    ],
    [
      "quay.io/prometheus/prometheus",
      "https://quay.io/repository/prometheus/prometheus",
      "Quay",
      "prometheus/prometheus",
    ],
    [
      "ghcr.io/fluxcd/source-controller:v1.3.0",
      "https://ghcr.io/fluxcd/source-controller",
      "GitHub Container Registry",
      "fluxcd/source-controller",
    ],
    [
      "public.ecr.aws/docker/library/nginx:1.27",
      "https://gallery.ecr.aws/docker/library/nginx",
      "ECR Public Gallery",
      "docker/library/nginx",
    ],
    [
      "mcr.microsoft.com/oss/kubernetes/pause:3.9",
      "https://mcr.microsoft.com/en-us/artifact/mar/oss/kubernetes/pause/about",
      "Microsoft Artifact Registry",
      "oss/kubernetes/pause",
    ],
  ];

  it.each(opens)("opens %s", (image, url, site, name) => {
    expect(link(image)).toEqual({ url, site, name });
  });

  const silent: [image: string, why: string][] = [
    ["registry.k8s.io/kube-apiserver:v1.31.0", "serves no web page"],
    ["gcr.io/google-containers/pause:3.9", "a Cloud console behind a sign-in"],
    ["registry.corp.internal/team/app:v1", "a private registry has no site"],
    ["localhost:5000/app:v1", "a local daemon has no site"],
    ["k8s.gcr.io/pause:3.9", "the retired mirror is no more browsable"],
    ["docker.io/too/deep/for-hub", "Hub has no repository that deep"],
    ["quay.io/lonely", "not a Quay org and repository"],
    ["ghcr.io/owner", "no package to name"],
    ["NOT A REF", "not a reference at all"],
  ];

  it.each(silent)("offers nothing for %s — %s", (image) => {
    expect(link(image)).toBeNull();
  });

  it("opens the tag the reader is looking at, and never a digest", () => {
    const digest = `sha256:${"a1b2c3d4".repeat(8)}`;
    // No site takes a digest in a URL, so the link says what it really opens.
    expect(link(`nginx@${digest}`)).toMatchObject({
      url: "https://hub.docker.com/_/nginx",
      name: "nginx",
    });
    expect(link(`nginx:1.25@${digest}`)).toMatchObject({
      url: "https://hub.docker.com/_/nginx/tags?name=1.25",
      name: "nginx:1.25",
    });
  });

  it("builds only from what the grammar vouched for", () => {
    // The reference arrives from the cluster. Every URL here is assembled from
    // parsed components, so a string the grammar refused cannot reach one —
    // which is what keeps a crafted image name out of the browser.
    for (const hostile of [
      "nginx:1.25 && rm -rf",
      "nginx:tag?name=other",
      "../../etc/passwd",
      "https://evil.example/x",
      "nginx:../../../r/evil/pkg",
    ]) {
      expect(link(hostile), hostile).toBeNull();
    }
  });
});
