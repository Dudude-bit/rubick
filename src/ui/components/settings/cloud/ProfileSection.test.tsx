import { describe, expect, it, vi } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/commands", () => ({
  commands: { forgetDiscovery: vi.fn(async () => undefined) },
}));

import { ProfileRow, ProfileSection } from "./ProfileSection";

describe("a list of cloud profiles", () => {
  /**
   * `isEmpty={!profiles}` drew a failed read as "no profiles". Fails if an
   * error reaches the empty sentence instead of a retry.
   */
  it("says the list could not be read, never that there are none", async () => {
    const retry = vi.fn(async () => undefined);
    render(
      <ProfileSection
        title="GCP"
        addLabel="Add"
        onAdd={() => {}}
        isLoading={false}
        error={new Error("refused")}
        onRetry={retry}
        isEmpty
        emptyMessage="No GCP profiles"
      >
        {null}
      </ProfileSection>
    );
    expect(screen.queryByText("No GCP profiles")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Try the read again" })
    );
    expect(retry).toHaveBeenCalled();
  });
});

describe("a profile row", () => {
  /**
   * Delete went straight to the write and could be pressed twice. Fails if
   * the write runs before the confirmation, or if the row's other actions
   * stay live while one runs.
   */
  it("deletes only after the confirmation and locks its actions while busy", async () => {
    const onDelete = vi.fn(async () => undefined);
    const user = userEvent.setup();
    const { rerender } = render(
      <ProfileRow name="deploy" onEdit={() => {}} onDelete={onDelete} />
    );
    await user.click(screen.getByRole("button", { name: "Delete deploy" }));
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);

    rerender(
      <ProfileRow name="deploy" onEdit={() => {}} onDelete={onDelete} busy />
    );
    expect(
      screen.getByRole("button", { name: "Delete deploy" })
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
  });
});
