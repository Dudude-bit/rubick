import { useEffect } from "react";
import { Keyboard } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { claimedByTarget } from "@/hooks/useCopyLink";
import { useT } from "@/i18n/useT";
import { SHORTCUTS } from "@/lib/shortcuts";
import { useShortcutsStore } from "@/stores/shortcutsStore";

/**
 * Every key the app answers to, on one sheet, behind `?`. The status bar
 * hints at three of them and nothing said the rest existed; a reader who
 * learns `mod+shift+C` from a colleague should be able to find it here.
 */
export function ShortcutsOverlay() {
  const t = useT();
  const open = useShortcutsStore((state) => state.open);
  const setOpen = useShortcutsStore((state) => state.setOpen);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "?" || event.metaKey || event.ctrlKey || event.altKey)
        return;
      if (claimedByTarget(event.target)) return;
      event.preventDefault();
      useShortcutsStore.getState().setOpen(!useShortcutsStore.getState().open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="size-4 text-fg-fnt" aria-hidden />
            {t("shortcuts", "title")}
          </DialogTitle>
          <DialogDescription>{t("shortcuts", "hint")}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
          {SHORTCUTS.map((group) => (
            <section key={group.title} className="min-w-0">
              <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[.07em] text-fg-fnt">
                {t("shortcuts", group.title)}
              </h3>
              <ul className="flex flex-col">
                {group.items.map((item) => (
                  <li
                    key={item.says + item.keys.join()}
                    className="flex items-center justify-between gap-4 border-b border-hair py-1.5 text-xs text-fg-mid last:border-b-0"
                  >
                    <span>{t("shortcuts", item.says)}</span>
                    <span className="flex flex-none items-center gap-1 text-fg-fnt">
                      {item.keys.map((key, index) => (
                        <span key={key} className="flex items-center gap-1">
                          {index > 0 && (
                            <span className="text-[10px]">
                              {item.says === "tabByNumber" ||
                              item.says === "soloContainer"
                                ? "…"
                                : "/"}
                            </span>
                          )}
                          <Kbd shortcut={key} />
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
