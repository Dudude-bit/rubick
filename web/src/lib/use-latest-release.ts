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

export type Assets = Partial<Record<AssetKey, string>>;

export function useLatestRelease(): Assets {
  const [assets, setAssets] = useState<Assets>({});

  useEffect(() => {
    let cancelled = false;
    fetch(API)
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(String(r.status)))
      )
      .then(
        (rel: { assets: { name: string; browser_download_url: string }[] }) => {
          if (cancelled) return;
          const found: Assets = {};
          for (const a of rel.assets) {
            for (const key of Object.keys(PATTERNS) as AssetKey[]) {
              if (PATTERNS[key].test(a.name))
                found[key] = a.browser_download_url;
            }
          }
          setAssets(found);
        }
      )
      .catch(() => {
        // static fallback links to the releases page stay in place
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return assets;
}
