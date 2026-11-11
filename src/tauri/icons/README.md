# Icons

The AUR package
[rubick-kubernetes-bin](https://aur.archlinux.org/packages/rubick-kubernetes-bin)
fetches `128x128@2x.png`, `128x128.png`, `64x64.png`, `32x32.png` and
`icon.svg` by raw GitHub URL from `src-tauri/icons/` at each release tag, a
path from before the relayout. Copies of those five live there, and
`src/ui/release-assets.test.ts` holds them byte-identical to the ones here.
Change an icon here and copy it there; to drop the copies, ask the package's
maintainer to move the PKGBUILD to `src/tauri/icons/` first.
