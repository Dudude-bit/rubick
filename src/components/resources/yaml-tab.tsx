import type { DetailTab } from "./ResourceDetailLayout";
import { YamlTabContent, type YamlTabContentProps } from "./YamlTabContent";

/**
 * The YAML tab, identical on all fifteen detail pages.
 *
 * A surface, because a manifest is read against the window rather than
 * through a 500px slot cut into a page that scrolls as well.
 */
export function yamlTab(props: YamlTabContentProps): DetailTab {
  return {
    id: "yaml",
    label: "YAML",
    kind: "surface",
    content: <YamlTabContent {...props} />,
  };
}
