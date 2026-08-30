import { useEffect, useState } from "react";

const API = "https://api.github.com/repos/Dudude-bit/rubick/releases/latest";

export type AssetKey =
  "dmgArm" | "dmgIntel" | "exe" | "deb" | "rpm" | "appimage";

const PATTERNS: Record<AssetKey, RegExp> = {
  dmgArm: /aarch64\.dmg$/,
  dmgIntel: /x64\.dmg$/,
  exe: /x64-setup\.exe$/,
  deb: /amd64\.deb$/,
  rpm: /x86_64\.rpm$/,
  appimage: /amd64\.AppImage$/,
};

export type Asset = { url: string; name: string; size: number };

export type Release = {
  version: string | null;
  assets: Partial<Record<AssetKey, Asset>>;
};

const EMPTY: Release = { version: null, assets: {} };

export function useLatestRelease(): Release {
  const [release, setRelease] = useState<Release>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    fetch(API)
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(String(r.status)))
      )
      .then(
        (rel: {
          tag_name?: string;
          assets: {
            name: string;
            browser_download_url: string;
            size: number;
          }[];
        }) => {
          if (cancelled) return;
          const assets: Release["assets"] = {};
          for (const a of rel.assets) {
            for (const key of Object.keys(PATTERNS) as AssetKey[]) {
              if (PATTERNS[key].test(a.name)) {
                assets[key] = {
                  url: a.browser_download_url,
                  name: a.name,
                  size: a.size,
                };
              }
            }
          }
          setRelease({ version: rel.tag_name ?? null, assets });
        }
      )
      .catch(() => {
        // static fallback links to the releases page stay in place
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return release;
}

export function formatSize(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
