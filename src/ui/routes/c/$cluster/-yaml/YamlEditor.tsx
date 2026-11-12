import { lazy, Suspense } from "react";

import type { YamlEditorProps } from "./YamlEditorImpl";

export type { YamlEditorProps } from "./YamlEditorImpl";

/**
 * Lazy wrapper around the heavy CodeMirror-backed editor.
 *
 * `@uiw/react-codemirror` + `@codemirror/lang-yaml` + the codemirror
 * core add ~80 KB gzipped to the initial bundle and most users never
 * open a YAML view. Splitting it behind React.lazy means the chunk is
 * only fetched when the user navigates to a screen that mounts a
 * YamlEditor (resource details, CRDs, Helm).
 */
const YamlEditorImpl = lazy(() =>
  import("./YamlEditorImpl").then((mod) => ({ default: mod.YamlEditor }))
);

export function YamlEditor(props: YamlEditorProps) {
  return (
    <Suspense
      fallback={
        <div
          className={props.className}
          style={{ height: props.height ?? "100%" }}
          aria-busy="true"
        />
      }
    >
      <YamlEditorImpl {...props} />
    </Suspense>
  );
}
