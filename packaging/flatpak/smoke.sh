#!/usr/bin/env bash
# Launch the installed bundle on a virtual screen and decide whether a window
# with the app in it actually appeared.
#
# "The process stayed up" is not that. WebKit draws in a separate process,
# and when that process aborts — "Could not create default EGL display:
# EGL_BAD_PARAMETER. Aborting..." — the main process lives on behind a white
# window. The old check passed exactly that on every release, so this one
# looks at the screen.
#
#   smoke.sh <name> [flatpak run options...]
#
# Writes <name>.log and <name>.png, prints a verdict line, and exits non-zero
# when the window is not the app.
set -uo pipefail

name="$1"
shift

display=":$((90 + RANDOM % 9))"
Xvfb "$display" -screen 0 1600x1000x24 -nolisten tcp >/dev/null 2>&1 &
xvfb=$!
sleep 2

DISPLAY="$display" flatpak run "$@" com.k8s_gui.app >"$name.log" 2>&1 &
app=$!

# Long enough for the login-shell probe (bounded at 30s by the app) to be
# skipped or answered, the window to map and the first page to paint.
sleep 40

alive=yes
kill -0 "$app" 2>/dev/null || alive=no

DISPLAY="$display" import -window root "$name.png" 2>/dev/null
# How many distinct colours are on the screen. A window the web process
# never painted is one flat colour on the black root — 2 in total — and a
# window that never mapped is 1. The app, in either theme, is well over a
# thousand: text, icons and their antialiasing. Measured on both before the
# threshold was set, so neither "not white" (which a black screen passes)
# nor "not black" (which the white window passed) decides it.
colours=$(convert "$name.png" -format '%k' info: 2>/dev/null || echo 0)

kill "$app" 2>/dev/null
wait "$app" 2>/dev/null
kill "$xvfb" 2>/dev/null

broken=$(grep -iE "EGL_BAD|Could not create default EGL display|Aborting|Unable to spawn|Failed to spawn|cannot open shared object|No such schema|Failed to execute child|version \`[^']*' not found" "$name.log" | head -5)

verdict=ok
[ "$alive" = yes ] || verdict="did not stay up"
[ -z "$broken" ] || verdict="said something broke"
[ "$colours" -ge 100 ] || verdict="nothing painted ($colours colours on screen)"

echo "[$name] alive=$alive colours=$colours verdict=$verdict"
[ -z "$broken" ] || printf '%s\n' "$broken" | sed "s/^/[$name]   /"

[ "$verdict" = ok ]
