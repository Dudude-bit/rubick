import { useEffect, useRef, useState } from "react";
import { Section } from "../components/section";
import { LINKS } from "../lib/site";
import {
  formatSize,
  useLatestRelease,
  type Asset,
} from "../lib/use-latest-release";

type OS = "macos" | "windows" | "linux";

const TABS: { os: OS; label: string }[] = [
  { os: "macos", label: "macOS" },
  { os: "windows", label: "Windows" },
  { os: "linux", label: "Linux" },
];

function detect(): OS | null {
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return "macos";
  if (/Win/i.test(ua)) return "windows";
  if (/Linux/i.test(ua)) return "linux";
  return null;
}

function Comment({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-sm text-neutral-500"># {children}</p>;
}

function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  function copy() {
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="flex items-start gap-3">
      <span className="text-accent font-mono text-sm leading-6 select-none">
        $
      </span>
      <code className="min-w-0 flex-1 font-mono text-sm leading-6 break-all whitespace-pre-wrap text-neutral-100">
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy command"
        className="-my-1 shrink-0 rounded-md border border-neutral-700 px-2.5 py-1.5 font-mono text-xs text-neutral-300 transition-colors hover:border-neutral-500 hover:text-white"
      >
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}

function DownloadRow({
  asset,
  fallbackLabel,
  meta,
}: {
  asset: Asset | undefined;
  fallbackLabel: string;
  meta: string;
}) {
  return (
    <a
      href={asset?.url ?? LINKS.releases}
      className="group flex min-h-11 min-w-0 flex-col justify-center gap-1 rounded-lg border border-neutral-800 bg-neutral-900/60 px-4 py-2.5 transition-colors hover:border-neutral-600 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
    >
      <span className="min-w-0 truncate font-mono text-sm text-neutral-100">
        {asset?.name ?? fallbackLabel}
      </span>
      <span className="flex items-baseline gap-3 sm:shrink-0">
        <span className="text-sm text-neutral-500">
          {meta}
          {asset ? ` · ${formatSize(asset.size)}` : ""}
        </span>
        <span
          aria-hidden="true"
          className="font-mono text-sm text-neutral-500 transition-colors group-hover:text-accent"
        >
          {"↓"}
        </span>
      </span>
    </a>
  );
}

export function Install() {
  const { version, assets } = useLatestRelease();
  const [active, setActive] = useState<OS>("macos");
  const tabRefs = useRef<Partial<Record<OS, HTMLButtonElement | null>>>({});

  useEffect(() => {
    const mine = detect();
    if (mine) setActive(mine);
  }, []);

  function onTabKeyDown(e: React.KeyboardEvent) {
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.os === active);
    const next = TABS[(i + dir + TABS.length) % TABS.length];
    if (next) {
      setActive(next.os);
      tabRefs.current[next.os]?.focus();
    }
  }

  return (
    <Section id="install" eyebrow="Install">
      <h2 className="max-w-3xl font-display text-3xl font-bold tracking-tight md:text-5xl">
        Get it.
      </h2>
      <div className="mt-12 overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900 shadow-2xl shadow-black/50">
        <div className="flex items-center gap-4 border-b border-neutral-800 px-4">
          <div className="hidden gap-1.5 sm:flex" aria-hidden="true">
            <span className="size-3 rounded-full bg-neutral-700" />
            <span className="size-3 rounded-full bg-neutral-700" />
            <span className="size-3 rounded-full bg-neutral-700" />
          </div>
          <div
            role="tablist"
            aria-label="Operating system"
            onKeyDown={onTabKeyDown}
            className="flex"
          >
            {TABS.map((t) => (
              <button
                key={t.os}
                ref={(el) => {
                  tabRefs.current[t.os] = el;
                }}
                role="tab"
                type="button"
                aria-selected={active === t.os}
                aria-controls={`install-${t.os}`}
                tabIndex={active === t.os ? 0 : -1}
                onClick={() => setActive(t.os)}
                className={`-mb-px min-h-11 border-b-2 px-3 font-mono text-sm transition-colors sm:px-4 ${
                  active === t.os
                    ? "border-accent text-white"
                    : "border-transparent text-neutral-500 hover:text-neutral-300"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <span className="ml-auto hidden font-mono text-xs text-neutral-600 sm:block">
            {version ?? "latest"}
          </span>
        </div>

        <div className="min-h-64 bg-neutral-950/60 p-6 md:p-8">
          {active === "macos" && (
            <div
              id="install-macos"
              role="tabpanel"
              className="flex flex-col gap-5"
            >
              <div className="flex flex-col gap-2">
                <CommandLine command={LINKS.brew} />
                <Comment>
                  signed with a Developer ID certificate, notarised by Apple.
                  Opens on a double-click, like software should.
                </Comment>
              </div>
              <Comment>or take the .dmg straight:</Comment>
              <div className="grid gap-3 md:grid-cols-2">
                <DownloadRow
                  asset={assets.dmgArm}
                  fallbackLabel="Rubick.dmg"
                  meta="Apple silicon"
                />
                <DownloadRow
                  asset={assets.dmgIntel}
                  fallbackLabel="Rubick.dmg"
                  meta="Intel"
                />
              </div>
            </div>
          )}

          {active === "windows" && (
            <div
              id="install-windows"
              role="tabpanel"
              className="flex flex-col gap-5"
            >
              <DownloadRow
                asset={assets.exe}
                fallbackLabel="Rubick-setup.exe"
                meta="installer"
              />
              <div className="border-l-2 border-amber-400/60 py-1 pl-4">
                <p className="text-sm text-neutral-300">
                  The installer is not signed, so SmartScreen will warn you on
                  first launch. More info, then Run anyway.
                </p>
                <p className="mt-1 text-sm text-neutral-500">
                  We would rather tell you that here than let the dialog
                  surprise you.
                </p>
              </div>
            </div>
          )}

          {active === "linux" && (
            <div
              id="install-linux"
              role="tabpanel"
              className="flex flex-col gap-5"
            >
              <div className="grid gap-3">
                <DownloadRow
                  asset={assets.appimage}
                  fallbackLabel="Rubick.AppImage"
                  meta="needs nothing installed"
                />
                <DownloadRow
                  asset={assets.deb}
                  fallbackLabel="Rubick.deb"
                  meta="Debian, Ubuntu"
                />
                <DownloadRow
                  asset={assets.rpm}
                  fallbackLabel="Rubick.rpm"
                  meta="Fedora, openSUSE"
                />
              </div>
              <Comment>
                Arch:{" "}
                <a
                  href={LINKS.aur}
                  className="text-neutral-300 underline decoration-neutral-700 underline-offset-4 transition-colors hover:text-white"
                >
                  rubick-kubernetes-bin
                </a>{" "}
                is on the AUR, packaged by someone who is not us, from the same
                .deb we publish.
              </Comment>
            </div>
          )}
        </div>
      </div>
      <p className="mt-6 font-mono text-sm text-neutral-500">
        Every version, with signatures, lives on{" "}
        <a
          href={LINKS.releases}
          className="text-neutral-300 underline decoration-neutral-700 underline-offset-4 transition-colors hover:text-white"
        >
          GitHub Releases
        </a>
        .
      </p>
      <p className="mt-3 font-mono text-sm text-neutral-500">
        It talks to your clusters, and to GitHub to check for updates. Nothing
        else. There is nothing else to talk to.
      </p>
    </Section>
  );
}
