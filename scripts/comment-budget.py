#!/usr/bin/env python3
"""Refuse a patch that explains itself more than it changes anything.

One number, measured on the added lines of the diff alone, so nothing already
in the tree is judged and nobody has to go and shorten somebody else's module
header.

Density rather than length. A ceiling on how long one comment may be was
tried first and had to go: it fired on the module headers this codebase is
written with — the file-top paragraph naming the silent failure — while
catching almost none of the prose it was aimed at, which arrives as many
small blocks rather than one long one.

A doc comment sitting directly on a test is exempt. CLAUDE.md requires one on
every test, saying what would break, and a rule that punished the thing the
project asks for would only teach people to write worse tests.

Usage: comment-budget.py <base-ref> [head-ref]
"""

import re
import subprocess
import sys

MAX_DENSITY = 20  # per cent of added lines that may be comment

SOURCE = re.compile(r"\.(rs|ts|tsx)$")
COMMENT = ("//", "/*", "*", "#!")
# What a comment run has to be sitting on for the run to be a test's own.
TEST_SUBJECT = re.compile(
    r"^\s*(#\[(tokio::)?test\]|#\[cfg\(test\)\]|(it|test|describe)\s*[(<]|mod tests)"
)


def added_lines(base, head):
    """Every added line of the diff, grouped by the file it lands in."""
    result = subprocess.run(
        ["git", "diff", "--unified=0", f"{base}...{head}", "--", "*.rs", "*.ts", "*.tsx"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        # `base...head` diffs from the merge-base, which a shallow clone does
        # not contain. Say so plainly instead of crashing with a traceback —
        # the fix is a full-history checkout, not a change here.
        sys.exit(
            f"comment-budget: could not diff {base}...{head} "
            f"(is the checkout shallow? git said: {result.stderr.strip()})"
        )
    diff = result.stdout

    files, path = {}, None
    for line in diff.split("\n"):
        if line.startswith("+++ b/"):
            path = line[6:]
            if SOURCE.search(path):
                files.setdefault(path, [])
            else:
                path = None
        elif path and line.startswith("+") and not line.startswith("+++"):
            files[path].append(line[1:])
    return files


def runs(lines):
    """Comment runs as (length, index just past the run)."""
    out, run = [], 0
    for i, line in enumerate(lines):
        if line.strip().startswith(COMMENT):
            run += 1
        else:
            if run:
                out.append((run, i))
            run = 0
    if run:
        out.append((run, len(lines)))
    return out


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else "origin/main"
    head = sys.argv[2] if len(sys.argv) > 2 else "HEAD"
    files = added_lines(base, head)

    counted = commented = 0

    for path, lines in files.items():
        for length, after in runs(lines):
            # The line the run sits on decides whether it is a test's doc
            # comment — the run itself looks the same either way.
            subject = lines[after] if after < len(lines) else ""
            # Rust keeps its tests in the file they cover, so the line the run
            # sits on has to decide this, not the file's name.
            if TEST_SUBJECT.match(subject):
                continue
            commented += length
        counted += sum(1 for line in lines if line.strip())

    if not counted:
        print("comment budget: nothing to weigh")
        return 0

    density = commented * 100 // counted
    print(f"comment budget: {commented} of {counted} added lines ({density}%)")

    if density > MAX_DENSITY:
        print(
            f"\nToo much of this patch is comment: {density}%, and the ceiling "
            f"is {MAX_DENSITY}%.\nA doc comment on a test does not count "
            "towards this, so what is over the line is prose about the code.",
            file=sys.stderr,
        )
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
