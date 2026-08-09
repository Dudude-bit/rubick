import { describe, expect, it } from "vitest";

import { gitRepoLink, gitRevisionLink, shortRevision } from "./gitops";

const SHA = "eec06d1ea459af4cb4e10e806f8be7c7bd58b361";

describe("a git remote gets a link only where the address is mechanical", () => {
  /**
   * The whole rule, and the one this test exists to defend. Would break if
   * somebody started constructing a web address for a remote whose website
   * this app cannot know — an `ssh://` remote names a protocol with no site
   * behind it, `git@host:path` is not a URL at all, a self-hosted Gitea has a
   * URL shape that is a guess, and a remote carrying a token must never reach
   * a browser's address bar. A link that lands on a 404, a login wall or a
   * leaked credential makes the reader doubt the app rather than the link.
   */
  it.each([
    ["ssh://git@github.com/acme/infra.git"],
    ["git@github.com:acme/infra.git"],
    ["https://git.corp.internal/acme/infra.git"],
    ["https://gitea.example.com/acme/infra"],
    ["https://bitbucket.org/acme/infra"],
    ["http://github.com/acme/infra"],
    ["https://token:x-oauth-basic@github.com/acme/infra.git"],
    ["https://github.com/acme"],
    ["https://github.com/acme/infra/tree/main"],
    ["./manifests"],
    [""],
  ])("refuses %s", (url) => {
    expect(gitRepoLink(url)).toBeNull();
    expect(gitRevisionLink(url, SHA)).toBeNull();
  });

  it("resolves a GitHub remote to its repository and its commit", () => {
    expect(gitRepoLink("https://github.com/acme/infra.git")?.url).toBe(
      "https://github.com/acme/infra"
    );
    expect(gitRevisionLink("https://github.com/acme/infra", SHA)?.url).toBe(
      `https://github.com/acme/infra/commit/${SHA}`
    );
  });

  /** GitLab nests groups, and puts `/-/` in front of every non-repo path. */
  it("resolves a nested GitLab group", () => {
    const link = gitRevisionLink(
      "https://gitlab.com/acme/platform/infra.git",
      SHA
    );
    expect(link?.url).toBe(
      `https://gitlab.com/acme/platform/infra/-/commit/${SHA}`
    );
    expect(link?.site).toBe("GitLab");
  });

  /** A branch is not a commit, and `commit/main` is a 404 on both hosts. */
  it("sends a branch or tag to the tree rather than to a commit", () => {
    expect(gitRevisionLink("https://github.com/acme/infra", "main")?.url).toBe(
      "https://github.com/acme/infra/tree/main"
    );
    expect(
      gitRevisionLink("https://github.com/acme/infra", "release/1.2")?.url
    ).toBe("https://github.com/acme/infra/tree/release/1.2");
  });

  /** A revision this cannot classify falls back to the repository, never to a guessed path. */
  it("never invents a path for a revision it cannot read", () => {
    expect(
      gitRevisionLink("https://github.com/acme/infra", "master@sha1:beef")?.url
    ).toBe("https://github.com/acme/infra");
  });
});

describe("shortRevision", () => {
  it("cuts a commit and leaves a name alone", () => {
    expect(shortRevision(SHA)).toBe("eec06d1");
    expect(shortRevision("6.5.4")).toBe("6.5.4");
    expect(shortRevision("release-1.2")).toBe("release-1.2");
    expect(shortRevision("main")).toBe("main");
  });
});
