import { useEffect, useState } from "react";
import { FaApple, FaLinux, FaWindows } from "react-icons/fa6";
import { ButtonLink } from "./button-link";

type OS = "mac" | "windows" | "linux";

const ALL: { os: OS; label: string; Icon: typeof FaApple }[] = [
  { os: "mac", label: "Download for macOS", Icon: FaApple },
  { os: "windows", label: "Download for Windows", Icon: FaWindows },
  { os: "linux", label: "Download for Linux", Icon: FaLinux },
];

function detect(): OS | null {
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return "mac";
  if (/Win/i.test(ua)) return "windows";
  if (/Linux/i.test(ua)) return "linux";
  return null;
}

export function DownloadButtons() {
  const [mine, setMine] = useState<OS | null>(null);
  useEffect(() => setMine(detect()), []);

  const ordered = mine
    ? [...ALL].sort((a, b) => Number(b.os === mine) - Number(a.os === mine))
    : ALL;
  const [first, ...rest] = ordered;

  return (
    <div className="flex flex-wrap items-center gap-3">
      {first ? (
        <ButtonLink href="/#install">
          <first.Icon aria-hidden className="size-4" />
          {first.label}
        </ButtonLink>
      ) : null}
      {rest.map((d) => (
        <ButtonLink key={d.os} href="/#install" variant="ghost">
          <d.Icon aria-hidden className="size-4" />
          {d.label.replace("Download for ", "")}
        </ButtonLink>
      ))}
    </div>
  );
}
