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
# The fraction of near-white pixels on a 1600x1000 screen. The window is
# 1400x900 on a black root, so a blank one is ~0.79 and the app's own canvas,
# light theme or dark, is far below it.
white=$(convert "$name.png" -colorspace Gray -threshold 94% -format '%[fx:mean]' info: 2>/dev/null || echo 1)

kill "$app" 2>/dev/null
wait "$app" 2>/dev/null
kill "$xvfb" 2>/dev/null

broken=$(grep -iE "EGL_BAD|Could not create default EGL display|Aborting|Unable to spawn|Failed to spawn|cannot open shared object|No such schema|Failed to execute child|version \`[^']*' not found" "$name.log" | head -5)

verdict=ok
[ "$alive" = yes ] || verdict="did not stay up"
[ -z "$broken" ] || verdict="said something broke"
awk -v w="$white" 'BEGIN { exit !(w > 0.5) }' && verdict="blank window (white=$white)"

echo "[$name] alive=$alive white=$white verdict=$verdict"
[ -z "$broken" ] || printf '%s\n' "$broken" | sed "s/^/[$name]   /"

[ "$verdict" = ok ]
