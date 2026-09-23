#!/usr/bin/env python3
"""Whether the Tauri npm packages and crates agree on major.minor.

`tauri build` refuses to bundle when they do not ("Found version mismatched
Tauri packages"), which build.yml used to find twenty minutes into a macOS
job. This finds it from the two lockfiles in a second.

    check-tauri-versions.py [bun.lock] [Cargo.lock]
"""

import re
import sys

NPM = re.compile(r'^    "(@tauri-apps/(?:api|plugin-[a-z-]+))": \["[^"]+@(\d+\.\d+)\.', re.M)
CRATE = re.compile(r'^name = "(tauri(?:-plugin-[a-z-]+)?)"\nversion = "(\d+\.\d+)\.', re.M)


def npm_name(crate):
    return "@tauri-apps/api" if crate == "tauri" else "@tauri-apps/" + crate[len("tauri-"):]


def mismatches(bun_lock, cargo_lock):
    npm = dict(NPM.findall(bun_lock))
    crates = {}
    for name, version in CRATE.findall(cargo_lock):
        crates.setdefault(name, set()).add(version)
    if "tauri" not in crates or "@tauri-apps/api" not in npm:
        return ["could not find tauri in Cargo.lock or @tauri-apps/api in bun.lock"]
    found = []
    for crate, versions in sorted(crates.items()):
        package = npm_name(crate)
        # A plugin with no npm half (single-instance, fs) has nothing to agree with.
        if package not in npm:
            continue
        for version in sorted(versions):
            if version != npm[package]:
                found.append(f"{crate} {version}.x (Cargo.lock) vs {package} {npm[package]}.x (bun.lock)")
    return found


def main():
    bun_path = sys.argv[1] if len(sys.argv) > 1 else "bun.lock"
    cargo_path = sys.argv[2] if len(sys.argv) > 2 else "Cargo.lock"
    with open(bun_path) as bun, open(cargo_path) as cargo:
        found = mismatches(bun.read(), cargo.read())
    for line in found:
        print(f"::error::{line}")
    if found:
        sys.exit(1)
    print("tauri npm packages and crates agree")


if __name__ == "__main__":
    main()
