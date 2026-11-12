import { describe, expect, it, vi } from "vite-plus/test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

function Strip({ onValueChange }: { onValueChange: (tab: string) => void }) {
  return (
    <Tabs defaultValue="overview" onValueChange={onValueChange}>
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="shell">Shell</TabsTrigger>
        <TabsTrigger value="yaml">YAML</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">the overview</TabsContent>
      <TabsContent value="shell">a live shell</TabsContent>
      <TabsContent value="yaml">the manifest</TabsContent>
    </Tabs>
  );
}

describe("a tab strip walked with the keyboard", () => {
  /**
   * Lena arrowed past Shell on wd-demo and a live shell opened in the pod.
   * Fails if focus landing on a tab opens it.
   */
  it("moves the focus with the arrows and opens nothing until Enter or Space", async () => {
    const onValueChange = vi.fn();
    render(<Strip onValueChange={onValueChange} />);
    screen.getByRole("tab", { name: "Overview" }).focus();

    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Shell" })).toHaveFocus()
    );
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "YAML" })).toHaveFocus()
    );
    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.queryByText("a live shell")).toBeNull();

    await userEvent.keyboard("{Enter}");
    expect(onValueChange).toHaveBeenCalledWith("yaml");
    expect(screen.getByText("the manifest")).toBeInTheDocument();
  });
});
