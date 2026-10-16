import { afterEach, describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

import { useDependenciesStore } from "@/stores/dependenciesStore";
import { useLocaleStore } from "@/stores/localeStore";
import { usePrivacyStore } from "@/stores/privacyStore";
import { HelmStatusBanner } from "./HelmStatusBanner";

const missing = (searchedPaths: string[], error: string) =>
  useDependenciesStore.setState({
    helm: { available: false, version: null, error, path: null, searchedPaths },
  });

describe("the banner for a missing Helm CLI", () => {
  afterEach(() => {
    useLocaleStore.setState({ choice: null });
    useDependenciesStore.setState({ helm: null });
    usePrivacyStore.setState({ hidePaths: true, identity: null });
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

  /**
   * Lena's Helm page printed every directory searched under her sandboxed
   * home and her login's own while Redact names and paths was on. Fails if
   * either reaches the banner, or if unticking the box no longer shows them.
   */
  it("hides the home and the login in the paths it searched while the box is ticked", () => {
    usePrivacyStore.setState({
      identity: {
        roots: [
          { root: "/tmp/rubick-fix/live/lena/home", standIn: "~" },
          { root: "/home/belliel", standIn: "~" },
        ],
        user: "belliel",
      },
    });
    missing(
      [
        "/usr/bin/helm",
        "/tmp/rubick-fix/live/lena/home/.local/bin/helm",
        "/home/belliel/.cargo/bin/helm",
      ],
      "helm not found in any search location"
    );
    const { rerender } = render(<HelmStatusBanner />);
    expect(
      screen.getByText(
        "Looked in: /usr/bin/helm, ~/.local/bin/helm, ~/.cargo/bin/helm"
      )
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/lena|belliel/);

    usePrivacyStore.setState({ hidePaths: false });
    rerender(<HelmStatusBanner />);
    expect(document.body.textContent).toContain(
      "/home/belliel/.cargo/bin/helm"
    );
  });
});
