#!/usr/bin/env python3
"""Which platforms build.yml builds for this event, and why.

A pull request builds Linux only, unless it touches something that differs
per platform. Everything else builds all four. Prints `matrix=` and `reason=`
lines for $GITHUB_OUTPUT.

    build-matrix.py <event> <labels-json> <head-commit-message> [base]

`base` is the commit a pull request is compared against; the changed files,
before and after, are read with git. `ADDED_LABEL` is the label a `labeled`
event added.
"""

import fnmatch
import json
import os
import re
import subprocess
import sys

PLATFORMS = {
    "linux-x64": {
        "os": "ubuntu-24.04",
        "artifact_name": "k8s-gui-linux-x64",
        "target": "x86_64-unknown-linux-gnu",
        "is_linux": True,
    },
    # linux-arm64 disabled: libglib2.0-dev arm64 deps unresolvable on GitHub runners.
    "macos-arm64": {
        "os": "macos-latest",
        "artifact_name": "k8s-gui-macos-arm64",
        "target": "aarch64-apple-darwin",
        "is_macos": True,
    },
    "macos-x64": {
        "os": "macos-latest",
        "artifact_name": "k8s-gui-macos-x64",
        "target": "x86_64-apple-darwin",
        "is_macos": True,
    },
    "windows-x64": {
        "os": "windows-latest",
        "artifact_name": "k8s-gui-windows-x64",
        "target": "x86_64-pc-windows-msvc",
        "is_windows": True,
    },
}

# What a Linux build cannot vouch for on the other three: dependencies,
# bundling and its inputs, and the workflows themselves.
EVERY_PLATFORM = [
    "Cargo.toml",
    "Cargo.lock",
    "*/Cargo.toml",
    "rust-toolchain.toml",
    ".cargo/*",
    "src-tauri/build.rs",
    "src-tauri/tauri*.conf.json",
    "src-tauri/capabilities/*",
    "src-tauri/icons/*",
    "package.json",
    "bun.lock",
    "packaging/*",
    ".github/*",
    "scripts/build-matrix.py",
]

# Rust that compiles differently per platform. Only Windows is built before
# merge otherwise (ci.yml's console job), so macOS code would go unchecked
# until main. Matched in the whole of a changed file, not the diff alone: an
# edit inside a `#[cfg(target_os = "macos")]` body has the attribute only as
# context, and a removed attribute is only in the old file.
PLATFORM_CFG = re.compile(r"\btarget_(os|family|arch|env|vendor|abi|pointer_width|endian|feature|has_atomic)\b|cfg!?\([^\n]*\b(windows|unix)\b")


def git(*args):
    return subprocess.run(
        ["git", *args], check=True, capture_output=True, text=True
    ).stdout


def show(rev, path):
    """A file as it was at `rev`, or nothing where it did not exist."""
    result = subprocess.run(
        ["git", "show", f"{rev}:{path}"], capture_output=True, text=True
    )
    return result.stdout if result.returncode == 0 else ""


def plan(event, labels, message, changed, rust_sources, added=""):
    everything = list(PLATFORMS)
    if event == "push":
        # release.yml builds this very commit from its tag, signed.
        if message.startswith("release: "):
            return [], "a release commit: release.yml builds it"
        return everything, "a push to main"
    if event != "pull_request":
        return everything, f"{event}"
    if added and added != "build-all":
        return [], f"the {added} label, which changes no build"
    if "build-all" in labels:
        return everything, "the build-all label"
    for path in changed:
        for pattern in EVERY_PLATFORM:
            if fnmatch.fnmatch(path, pattern):
                return everything, f"{path} changed"
    for path, source in rust_sources.items():
        if PLATFORM_CFG.search(source):
            return everything, f"{path} has platform-specific Rust"
    return ["linux-x64"], "a pull request with nothing platform-specific"


def main():
    event, labels_json, message = sys.argv[1:4]
    base = sys.argv[4] if len(sys.argv) > 4 else None
    changed, rust_sources = [], {}
    if base:
        changed = git("diff", "--name-only", base, "HEAD").split()
        for path in changed:
            if path.endswith(".rs"):
                rust_sources[path] = "".join(
                    show(rev, path) for rev in (base, "HEAD")
                )
    labels = json.loads(labels_json or "[]") or []
    added = os.environ.get("ADDED_LABEL", "")
    names, reason = plan(event, labels, message, changed, rust_sources, added)
    include = [{"name": name, **PLATFORMS[name]} for name in names]
    print(f"matrix={json.dumps({'include': include})}")
    print(f"reason={reason}")


if __name__ == "__main__":
    main()
