const COLOUR =
  /(^|[^a-z0-9-])(bg|text|border|ring|fill|stroke|from|via|to)-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|white|black)([-/][0-9]{1,3})?(?![a-z0-9-])/;
const THEME_BRANCH = /(^|[^a-z0-9-])dark:/;
const LEGACY_TOKEN =
  /(^|[^a-z0-9-])(bg|text|border|ring|fill|stroke|from|via|to)-(background|foreground|card|popover|primary|secondary|muted|accent|destructive|input|border|ring)(-foreground)?(?![a-z0-9-])/;
const VENDOR_PATH = /(^|\/)integrations\/[^-]/;
const INTERVAL_KEY = /^refetchInterval(InBackground)?$/;

/** A rule that reports `message` on every node `test` accepts, for each node type listed. */
function guard(types, test, message) {
  return {
    meta: { type: "problem", messages: { refused: message } },
    create(context) {
      const check = (node) => {
        if (test(node)) context.report({ node, messageId: "refused" });
      };
      return Object.fromEntries(types.map((type) => [type, check]));
    },
  };
}

const stringMatching = (pattern) => (node) =>
  typeof node.value === "string" && pattern.test(node.value);

const sourceMatching = (pattern) => (node) =>
  node.source?.type === "Literal" && stringMatching(pattern)(node.source);

export default {
  meta: { name: "rubick" },
  rules: {
    // 45 hand-written intervals made an idle app cost the API server ~1000
    // requests a minute; useLiveQuery stops polling a screen nobody sees.
    "no-refetch-interval": guard(
      ["Property", "TSPropertySignature"],
      (node) => INTERVAL_KEY.test(node.key?.name ?? ""),
      "Do not set refetchInterval. Use useLiveQuery({ refresh: '<rate>' }); the rates live in src/ui/lib/refresh.ts, and going through the hook is what stops a screen nobody is looking at from polling and what keeps the freshness badge honest about a backed-off query."
    ),
    "no-raw-colour": guard(
      ["Literal"],
      stringMatching(COLOUR),
      "Use a role token (bg-canvas, text-fg-mut, text-ok, text-err, ...) instead of a raw Tailwind colour."
    ),
    "no-theme-branch": guard(
      ["Literal"],
      stringMatching(THEME_BRANCH),
      "Do not branch on the theme in a component. Role tokens already resolve per theme in index.css."
    ),
    // The scaffold's palette still resolves, so nothing breaks: the component
    // just quietly leaves the design system.
    "no-legacy-token": guard(
      ["Literal"],
      stringMatching(LEGACY_TOKEN),
      "Legacy shadcn token. Use a role token: bg-canvas / bg-raise, border-hair, bg-hover, bg-sel, text-fg / text-fg-mid / text-fg-mut / text-fg-fnt, text-ok / text-warn / text-err / text-info."
    ),
    // cert-manager landed twice, in two systems, because nothing refused the
    // second import. Files inside the folder reach each other relatively.
    "no-vendor-import": guard(
      [
        "ImportDeclaration",
        "ImportExpression",
        "ExportNamedDeclaration",
        "ExportAllDeclaration",
      ],
      sourceMatching(VENDOR_PATH),
      "Ask for a facet, not for a vendor: import { useCapability, useCrdView, flavourOf, ... } from '@/integrations'. Nothing outside src/ui/integrations/ names a vendor."
    ),
    // statusRole() looks the status up in a table of English keys and falls
    // back to neutral, so a translated one greys every badge with tests green.
    "status-is-a-code": guard(
      ["JSXAttribute"],
      (node) =>
        node.name?.name === "status" &&
        node.value?.type === "JSXExpressionContainer" &&
        node.value.expression?.type === "CallExpression" &&
        /^(t|translate)$/.test(node.value.expression.callee?.name ?? ""),
      "StatusBadge's `status` decides the colour by table lookup, so it must stay the untranslated code. Put the translated text in children: <StatusBadge status={code}>{label}</StatusBadge>."
    ),
    // The OS paints it: in a dark window it opens white. Reported an hour
    // after a release.
    "no-native-select": guard(
      ["JSXOpeningElement"],
      (node) => node.name?.name === "select",
      "Use the shared Select from components/ui/select. A native <select> is painted by the OS and does not follow the app's theme."
    ),
  },
};
