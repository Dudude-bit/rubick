import { Braces } from "lucide-react";

import { viewGlyph, type DetailTab } from "./detail-tab";
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
    glyph: viewGlyph(Braces),
    kind: "surface",
    content: <YamlTabContent {...props} />,
  };
}
