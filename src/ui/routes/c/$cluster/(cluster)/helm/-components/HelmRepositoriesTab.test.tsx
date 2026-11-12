import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import { HelmRepositoriesTab } from "./HelmRepositoriesTab";

/**
 * A chart repository added as `https://user:pass@host` is listed by its
 * address, and a screenshot of the tab carried the password. Fails if the
 * row draws what stands before the host.
 */
describe("a Helm repository's address in the list", () => {
  it("names the host and path and not the credentials before them", () => {
    render(
      <HelmRepositoriesTab
        repositories={[
          {
            name: "internal",
            url: "https://ci:S3cret@charts.example.com/stable",
          },
        ]}
        isLoading={false}
        isUpdating={false}
        onUpdateAll={() => {}}
        onAddRepoClick={() => {}}
        onDeleteRepo={() => {}}
      />
    );
    expect(
      screen.getByText("https://…@charts.example.com/stable")
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("S3cret");
  });
});
