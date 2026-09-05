import { useEffect, useState } from "react";
import { FaGithub } from "react-icons/fa6";
import { LINKS, SITE } from "../lib/site";
import { ButtonLink } from "../components/button-link";
import { LogoMark } from "../components/logo-mark";

function useScrolled() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const read = () => setScrolled(window.scrollY > 8);
    read();
    window.addEventListener("scroll", read, { passive: true });
    return () => window.removeEventListener("scroll", read);
  }, []);
  return scrolled;
}

export function Nav() {
  const scrolled = useScrolled();
  return (
    <header
      className={`sticky top-0 z-50 border-b backdrop-blur transition-[border-color,background-color] duration-200 ${
        scrolled
          ? "border-neutral-800/80 bg-neutral-950/85"
          : "border-transparent bg-neutral-950/40"
      }`}
    >
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
        <a
          href="/"
          className="flex items-center gap-2.5 font-display text-lg font-bold tracking-tight"
        >
          <LogoMark className="size-6" />
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
