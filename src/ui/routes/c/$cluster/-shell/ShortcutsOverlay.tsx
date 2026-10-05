import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRouterState } from "@tanstack/react-router";

import { OutLink } from "@/components/ui/out-link";
import { kindDocs, kindOfPath, RUBICK_DOCS } from "@/lib/docs";
import { formatShortcut } from "@/lib/platform";
import { SECTIONS, SHORTCUTS, type Shortcut } from "@/lib/shortcuts";
import { useShortcutsOverlayStore } from "@/stores/shortcutsOverlayStore";
import { useT } from "@/i18n/useT";

function Keys({ entry }: { entry: Shortcut }) {
  const t = useT();
  const chord = entry.section === "navigate";
  return (
    <span className="flex items-center gap-1 font-mono text-[11px]">
      {entry.keys.map((key, index) => (
        <span key={key} className="flex items-center gap-1">
          {index > 0 && (
            <span className="text-fg-fnt">
              {chord ? t("shortcuts", "then") : "/"}
            </span>
          )}
          <kbd className="rounded border border-hair px-1.5 py-0.5 text-fg-mid">
            {formatShortcut(key)}
          </kbd>
        </span>
      ))}
    </span>
  );
}

/** Every key the app answers to, drawn from the one table that defines them. */
export function ShortcutsOverlay() {
  const t = useT();
  const open = useShortcutsOverlayStore((s) => s.open);
  const close = useShortcutsOverlayStore((s) => s.close);
  const kind = useRouterState({
    select: (state) => kindOfPath(state.location.pathname),
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("shortcuts", "title")}</DialogTitle>
          <DialogDescription>{t("shortcuts", "lede")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-x-8 gap-y-4 text-xs sm:grid-cols-2">
          {SECTIONS.map((section) => (
            <section key={section} data-testid={`shortcuts-${section}`}>
              <h3 className="mb-1.5 text-[11px] uppercase tracking-wide text-fg-fnt">
                {t("shortcuts", SECTION_KEY[section])}
              </h3>
              <ul className="flex flex-col gap-1">
                {SHORTCUTS.filter((entry) => entry.section === section).map(
                  (entry) => (
                    <li
                      key={entry.id}
                      className="flex items-baseline justify-between gap-3"
                    >
                      <span className="text-fg-mut">
                        {t("shortcuts", entry.labelKey)}
                      </span>
                      <Keys entry={entry} />
                    </li>
                  )
                )}
              </ul>
            </section>
          ))}
        </div>
        <footer className="flex flex-wrap gap-x-4 gap-y-1 border-t border-hair pt-3 text-xs">
          <OutLink href={RUBICK_DOCS} site="GitHub">
            {t("shortcuts", "docs")}
          </OutLink>
          {kind && (
            <OutLink href={kindDocs(kind)} site="kubernetes.io">
              {t("shortcuts", "kindDocs", { kind })}
            </OutLink>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}

const SECTION_KEY = {
  global: "sectionGlobal",
  navigate: "sectionNavigate",
  page: "sectionPage",
  tabs: "sectionTabs",
  table: "sectionTable",
  tree: "sectionTree",
  logs: "sectionLogs",
} as const;
