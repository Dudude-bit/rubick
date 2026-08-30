import { FaGithub } from "react-icons/fa6";
import { LINKS, SITE } from "../lib/site";
import { ButtonLink } from "../components/button-link";

export function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-neutral-800/60 bg-neutral-950/80 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
        <a href="/" className="font-display text-lg font-bold tracking-tight">
          {SITE.name}
        </a>
        <nav className="flex items-center gap-6">
          <a
            href={LINKS.github}
            className="flex min-h-11 items-center gap-2 text-sm text-neutral-400 transition-colors hover:text-white"
          >
            <FaGithub aria-hidden className="size-4" />
            GitHub
          </a>
          <ButtonLink href="#install">Download</ButtonLink>
        </nav>
      </div>
    </header>
  );
}
