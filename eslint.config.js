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
    // The one file allowed to name a polling interval. Exempting it here
    // rather than in a config object of its own is deliberate: a second
    // object naming `no-restricted-syntax` would replace this whole list
    // instead of adding to it, and quietly switch the colour guard off for
    // the file it matched.
    ignores: ["src/hooks/useLiveQuery.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          // What made an idle app cost the API server ~1000 requests a
          // minute: 45 hand-written intervals, of which 2 checked whether
          // anybody was looking at the screen they belonged to.
          //
          // The number is not the problem — the number with nothing around
          // it is. `useLiveQuery` asks for a *rate* and derives the interval
          // from whether the surface is on screen, whether the window has
          // focus, and whether the answer has stopped changing; and it is
          // what tells `DataFreshness` to stop saying "polling" once it has
          // backed off. A `refetchInterval` written by hand has none of
          // that, and no way to acquire it later.
          selector:
            "Property[key.name=/^refetchInterval(InBackground)?$/], TSPropertySignature[key.name=/^refetchInterval(InBackground)?$/]",
          message:
            "Do not set refetchInterval. Use useLiveQuery({ refresh: '<rate>' }) — the rates live in src/lib/refresh.ts, and going through the hook is what stops a screen nobody is looking at from polling and what keeps the freshness badge honest about a backed-off query.",
        },
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
          // A vendor contributes facets, and a surface asks for the facet
          // rather than for the vendor. The moment one page imports
          // `@/integrations/cert-manager` directly the seam stops being a
          // boundary and becomes a folder, and every consuming surface
          // quietly acquires an opinion about which vendors exist.
          //
          // This is what stops the drift that made the tree necessary:
          // cert-manager had landed twice, in two systems, because nothing
          // refused the second one. It covers every folder in the tree the
          // moment it is created — the tier-one vendors that carry only a
          // node label or a mark are behind the same door as the ones that
          // supply a capability, because "where does GKE's spelling live"
          // must have exactly one answer.
          //
          // `@/integrations` is the door and stays open; only reaching past
          // it into a named vendor is refused. Files inside the folder
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
            "Ask for a facet, not for a vendor: import { useCapability, useCrdView, flavourOf, ... } from '@/integrations'. Nothing outside src/integrations/ names a vendor.",
        },
        {
          // The one that turns the whole interface grey without failing.
          //
          // `statusRole()` derives a badge's colour by looking the status up
          // in a table of English keys, and misses fall back to `neutral`
          // rather than throwing. Hand it a translated string and every
          // badge in the app loses its severity at once — silently, with
          // every test still green, because the tests pass English.
          //
          // So `status` is a code and never copy. A translated label goes in
          // `children`, which the badge already renders in preference to it.
          selector:
            "JSXAttribute[name.name='status'] > JSXExpressionContainer > CallExpression[callee.name=/^(t|translate)$/]",
          message:
            "StatusBadge's `status` decides the colour by table lookup, so it must stay the untranslated code. Put the translated text in children: <StatusBadge status={code}>{label}</StatusBadge>.",
        },
      ],
    },
  },
];
