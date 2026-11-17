import { describe, expect, it } from "vite-plus/test";
import { screen } from "@testing-library/react";

import { renderWithRouter } from "@/test/render";
import { SubjectRef } from "./SubjectRef";

describe("an audited object's reference", () => {
  /**
   * A Helm release has no kind the registry knows, so a plain reference
   * would draw it as text. Fails if a release row stopped leading to the
   * release's own page.
   */
  it("leads a Helm release to its release page, named in words", async () => {
    await renderWithRouter(
      <SubjectRef
        subject={{
          kind: "HelmRelease.helm.sh",
          namespace: "shop",
          name: "web",
        }}
      />,
      { at: "/c/prod/audit", route: "/c/$cluster/$resource" }
    );
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/c/prod/helm/native/shop/web");
    expect(link).toHaveTextContent("Helm release");
    expect(link).not.toHaveTextContent("HelmRelease.helm.sh");
  });

  /** A deprecated API is no object: it is named in words, and links nowhere it could not be opened. */
  it("names a deprecated API the server was asked for without a link", async () => {
    await renderWithRouter(
      <SubjectRef
        subject={{
          kind: "DeprecatedAPI.k8s.io",
          namespace: null,
          name: "extensions/v1beta1 ingresses",
        }}
      />,
      { at: "/c/prod/audit", route: "/c/$cluster/$resource" }
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Deprecated API")).toBeInTheDocument();
    expect(
      screen.getByText("extensions/v1beta1 ingresses")
    ).toBeInTheDocument();
  });
});
