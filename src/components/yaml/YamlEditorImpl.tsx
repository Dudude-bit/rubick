import { useEffect, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { yaml as yamlLanguage } from "@codemirror/lang-yaml";
import { EditorView } from "@codemirror/view";
import { useThemeStore } from "@/stores/themeStore";
import { editorTheme } from "./editor-theme";
import { foldMachineDocuments, machineDocumentFolding } from "./machine-fold";

export interface YamlEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  height?: string;
  className?: string;
  showLineNumbers?: boolean;
  showFoldGutter?: boolean;
}

export function YamlEditor({
  value,
  onChange,
  readOnly = false,
  height = "100%",
  className,
  showLineNumbers = true,
  showFoldGutter = true,
}: YamlEditorProps) {
  const theme = useThemeStore((state) => state.theme);
  const [view, setView] = useState<EditorView | null>(null);

  const extensions = useMemo(
    () => [
      yamlLanguage(),
      EditorView.lineWrapping,
      machineDocumentFolding,
      // Last, so it outranks the base setup's fallback highlight style.
      editorTheme(theme === "dark"),
    ],
    [theme]
  );

  // Re-run per document rather than once per mount: the dialog swaps the
  // manifest under a live editor, and a fold state belongs to the text it
  // was computed from. Ranges the reader already opened are not re-folded
  // within one document, so reading is not undone by a re-render.
  useEffect(() => {
    if (view) foldMachineDocuments(view);
  }, [view, value]);

  return (
    <CodeMirror
      value={value}
      height={height}
      // The palette is ours; see editor-theme.ts.
      theme="none"
      extensions={extensions}
      onChange={readOnly ? undefined : onChange}
      onCreateEditor={(created) => setView(created)}
      editable={!readOnly}
      className={className}
      basicSetup={{
        lineNumbers: showLineNumbers,
        highlightActiveLineGutter: !readOnly,
        highlightActiveLine: !readOnly,
        foldGutter: showFoldGutter,
        autocompletion: !readOnly,
        bracketMatching: true,
        indentOnInput: !readOnly,
      }}
    />
  );
}
