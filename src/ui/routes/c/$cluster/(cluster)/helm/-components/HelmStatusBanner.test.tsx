import { afterEach, describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

import { useDependenciesStore } from "@/stores/dependenciesStore";
import { useLocaleStore } from "@/stores/localeStore";
import { HelmStatusBanner } from "./HelmStatusBanner";

const missing = (searchedPaths: string[], error: string) =>
  useDependenciesStore.setState({
    helm: { available: false, version: null, error, path: null, searchedPaths },
  });

describe("the banner for a missing Helm CLI", () => {
  afterEach(() => {
    useLocaleStore.setState({ choice: null });
    useDependenciesStore.setState({ helm: null });
  });

  /** "helm not found in any search location" sat in English under a Russian title. */
  it("says where it looked in the reader's language", () => {
    useLocaleStore.setState({ choice: "ru" });
    missing(
      ["/usr/local/bin/helm", "/opt/homebrew/bin/helm"],
      "helm not found in any search location"
    );
    render(<HelmStatusBanner />);
    expect(
      screen.getByText(
        "Где искали: /usr/local/bin/helm, /opt/homebrew/bin/helm"
      )
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("not found in any");
  });

  /** With nothing searched the error is all there is to say, so it stays. */
  it("keeps the error when nothing was searched", () => {
    missing([], "the check itself failed");
    render(<HelmStatusBanner />);
    expect(screen.getByText("the check itself failed")).toBeInTheDocument();
  });
});
