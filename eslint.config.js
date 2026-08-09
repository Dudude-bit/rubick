import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "src/generated/**",
      "src-tauri/**",
      "target/**",
      "artifacts/**",
      "**/*.config.{js,ts,cjs,mjs}",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // The design system is a single flat canvas driven by role tokens.
    // A raw colour utility silently opts a component out of theming, and
    // that is exactly how 344 of them accumulated. Components also never
    // branch on the theme: the role token already resolves per theme.
    //
    // The guard started life scoped to `ui/`, because that was the only
    // part converted at the time. It covers all of `src/` now that the
    // rest has caught up — the point of the rule is that there is no
    // corner left where drift is allowed to start again.
    //
    // Every `no-restricted-syntax` selector in the project lives in this
    // one block, including the one that has nothing to do with colour. A
    // second config object naming the same rule does not add to this list,
    // it replaces it — which silently switches the colour guard off for
    // every file the later block matches.
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Literal[value=/(^|[^a-z0-9-])(bg|text|border|ring|fill|stroke|from|via|to)-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|white|black)([-/][0-9]{1,3})?(?![a-z0-9-])/]",
          message:
            "Use a role token (bg-canvas, text-fg-mut, text-ok, text-err, ...) instead of a raw Tailwind colour.",
        },
        {
          selector: "Literal[value=/(^|[^a-z0-9-])dark:/]",
          message:
            "Do not branch on the theme in a component. Role tokens already resolve per theme in index.css.",
        },
        {
          // The shadcn palette the app was scaffolded with. These names
          // still resolve, which is why they survived so long: nothing
          // breaks, the component just quietly leaves the design system.
          selector:
            "Literal[value=/(^|[^a-z0-9-])(bg|text|border|ring|fill|stroke|from|via|to)-(background|foreground|card|popover|primary|secondary|muted|accent|destructive|input|border|ring)(-foreground)?(?![a-z0-9-])/]",
          message:
            "Legacy shadcn token. Use a role token: bg-canvas / bg-raise, border-hair, bg-hover, bg-sel, text-fg / text-fg-mid / text-fg-mut / text-fg-fnt, text-ok / text-warn / text-err / text-info.",
        },
        {
          // The same guard, pointed at a different drift.
          //
          // An extension contributes capabilities, and a surface asks for
          // the capability rather than for the extension. The moment one
          // page imports `@/integrations/cert-manager` directly the seam
          // stops being a boundary and becomes a folder, and every
          // consuming surface quietly acquires an opinion about which
          // extensions exist.
          //
          // `@/integrations` is the door and stays open; only reaching past
          // it into a named extension is refused. Files inside the folder
          // reach each other by relative path, which is how they are
          // exempt without needing a second config object.
          selector: [
            "ImportDeclaration",
            "ImportExpression",
            "ExportNamedDeclaration",
            "ExportAllDeclaration",
          ]
            .map((node) => `${node} > Literal[value=/(^|\\/)integrations\\/./]`)
            .join(", "),
          message:
            "Ask for a capability, not for an extension: import { useCapability } from '@/integrations'. Nothing outside src/integrations/ names an extension.",
        },
      ],
    },
  },
];
