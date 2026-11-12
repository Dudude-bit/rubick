import type * as ShareAction from "@/components/share/ShareAction";

/**
 * For `vi.mock("@/components/share/ShareAction", …)`: the real Share, with
 * the scope its screen states printed beside it as `shared-scope`, so a
 * page's test can read what the file would be told without opening a dialog.
 */
export async function withSharedScope(
  original: () => Promise<typeof ShareAction>
): Promise<typeof ShareAction> {
  const actual = await original();
  return {
    ...actual,
    ShareScreenAction: (props) => (
      <>
        <actual.ShareScreenAction {...props} />
        <output data-testid="shared-scope">
          {JSON.stringify(props.screen.scope)}
        </output>
      </>
    ),
  };
}
