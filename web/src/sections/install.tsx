import { ButtonLink } from "../components/button-link";
import { CopyCommand } from "../components/copy-command";
import { Section } from "../components/section";
import { LINKS } from "../lib/site";
import { useLatestRelease } from "../lib/use-latest-release";

function AssetLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      className="font-mono text-sm text-neutral-200 underline decoration-neutral-700 underline-offset-4 transition-colors hover:text-white"
    >
      {children}
    </a>
  );
}

export function Install() {
  const assets = useLatestRelease();

  return (
    <Section id="install" eyebrow="Install">
      <h2 className="max-w-3xl font-display text-3xl font-bold tracking-tight md:text-5xl">
        Get it.
      </h2>
      <div className="mt-12 grid gap-4 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col rounded-xl border border-neutral-800 bg-neutral-900/60 p-6">
          <h3 className="font-mono text-sm font-medium">macOS</h3>
          <div className="mt-4">
            <CopyCommand command={LINKS.brew} />
          </div>
          <p className="mt-4 flex-1 text-sm text-neutral-400">
            Signed with a Developer ID certificate and notarised by Apple. Opens
            on a double-click, like software should.
          </p>
          <p className="mt-5 text-sm text-neutral-400">
            Or the .dmg directly:{" "}
            <AssetLink href={assets.dmgArm ?? LINKS.releases}>
              Apple silicon
            </AssetLink>
            {" / "}
            <AssetLink href={assets.dmgIntel ?? LINKS.releases}>
              Intel
            </AssetLink>
          </p>
        </div>
        <div className="flex min-w-0 flex-col rounded-xl border border-neutral-800 bg-neutral-900/60 p-6">
          <h3 className="font-mono text-sm font-medium">Windows</h3>
          <p className="mt-4 flex-1 text-sm text-neutral-400">
            Not signed, so SmartScreen will warn you on first launch. More info,
            then Run anyway. We would rather tell you that here than let the
            dialog surprise you.
          </p>
          <div className="mt-5">
            <ButtonLink href={assets.exe ?? LINKS.releases} variant="ghost">
              Download the installer
            </ButtonLink>
          </div>
        </div>
        <div className="flex min-w-0 flex-col rounded-xl border border-neutral-800 bg-neutral-900/60 p-6">
          <h3 className="font-mono text-sm font-medium">Linux</h3>
          <p className="mt-4 flex-1 text-sm text-neutral-400">
            An AppImage needs nothing installed. Arch users:{" "}
            <a
              href={LINKS.aur}
              className="text-neutral-200 underline decoration-neutral-700 underline-offset-4 transition-colors hover:text-white"
            >
              rubick-kubernetes-bin
            </a>{" "}
            is on the AUR, packaged by someone who is not us, from the same .deb
            we publish.
          </p>
          <p className="mt-5 text-sm text-neutral-400">
            Pick your format:{" "}
            <AssetLink href={assets.deb ?? LINKS.releases}>.deb</AssetLink>
            {" / "}
            <AssetLink href={assets.rpm ?? LINKS.releases}>.rpm</AssetLink>
            {" / "}
            <AssetLink href={assets.appimage ?? LINKS.releases}>
              .AppImage
            </AssetLink>
          </p>
        </div>
      </div>
      <p className="mt-10 font-mono text-sm text-neutral-500">
        It talks to your clusters, and to GitHub to check for updates. Nothing
        else. There is nothing else to talk to.
      </p>
    </Section>
  );
}
