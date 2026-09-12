import { useQuery } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";

import changelog from "../../../CHANGELOG.md?raw";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useT } from "@/i18n/useT";
import {
  parseChangelog,
  releasesSince,
  type ChangeItem,
  type Release,
} from "@/lib/changelog";
import { commands } from "@/lib/commands";
import { useWhatsNewStore } from "@/stores/whatsNewStore";

const RELEASES = parseChangelog(changelog);

/**
 * The release notes, shown once after an update. The notes live in
 * `CHANGELOG.md` and nowhere else, and a reader who does not follow the
 * repository never saw them; the first launch of a new version now opens
 * them, and About keeps a way back to the current ones.
 */
export function WhatsNew() {
  const t = useT();
  const { data: appInfo } = useQuery({
    queryKey: ["appInfo"],
    queryFn: commands.getAppInfo,
    staleTime: Infinity,
  });
  const version = appInfo?.version ?? null;
  const seen = useWhatsNewStore((state) => state.seenVersion);
  const showing = useWhatsNewStore((state) => state.showing);
  const markSeen = useWhatsNewStore((state) => state.markSeen);
  const show = useWhatsNewStore((state) => state.show);
  const close = useWhatsNewStore((state) => state.close);

  useEffect(() => {
    if (version === null || seen === version) return;
    // A first launch has nothing that is new to this reader; it only
    // records where they start from.
    const arrived = releasesSince(RELEASES, seen, version);
    if (arrived.length > 0) show(arrived.map((release) => release.version));
    markSeen(version);
  }, [version, seen, show, markSeen]);

  const releases = showing
    .map((v) => RELEASES.find((release) => release.version === v))
    .filter((release): release is Release => release !== undefined);
  if (releases.length === 0) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>
            {t("settings", "whatsNewIn", { version: releases[0].version })}
          </DialogTitle>
          <DialogDescription>
            {releases.length > 1
              ? t("settings", "whatsNewSince", {
                  version: releases[releases.length - 1].version,
                })
              : (releases[0].date ?? "")}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1 pr-3">
          <div className="flex flex-col gap-5">
            {releases.map((release) => (
              <section key={release.version} className="flex flex-col gap-3">
                {releases.length > 1 && (
                  <h3 className="font-mono text-xs text-fg-fnt">
                    {release.version}
                    {release.date ? ` · ${release.date}` : ""}
                  </h3>
                )}
                {release.sections.map((section) => (
                  <div key={section.title}>
                    <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[.07em] text-fg-fnt">
                      {section.title}
                    </h4>
                    <Items items={section.items} />
                  </div>
                ))}
              </section>
            ))}
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button size="sm" onClick={close}>
            {t("action", "close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Items({ items }: { items: ChangeItem[] }) {
  return (
    <ul className="flex flex-col gap-1.5 pl-4 text-xs leading-relaxed text-fg-mut [&>li]:list-disc">
      {items.map((item, index) => (
        <li key={index}>
          {inline(item.text)}
          {item.children.length > 0 && (
            <ul className="mt-1 flex flex-col gap-1 pl-4 [&>li]:list-[circle]">
              {item.children.map((child, childIndex) => (
                <li key={childIndex}>{inline(child.text)}</li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

/** `**bold**` and `` `code` ``, which is all the notes use. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    if (match[1] !== undefined)
      out.push(
        <strong key={match.index} className="font-semibold text-fg">
          {match[1]}
        </strong>
      );
    else
      out.push(
        <code key={match.index} className="font-mono text-[11px] text-fg">
          {match[2]}
        </code>
      );
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
