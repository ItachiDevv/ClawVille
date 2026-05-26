import sys

CURLY = "’"    # RIGHT SINGLE QUOTATION MARK
STRAIGHT = "'" # APOSTROPHE

path = "apps/web/src/lib/three/arena-buildings.tsx"
with open(path, "r", encoding="utf-8") as f:
    lines = f.readlines()

changed = 0
for i, l in enumerate(lines):
    stripped = l.lstrip()
    # Only fix actual data lines (not comment lines starting with //)
    if ("childScaleOverrides" in l or "bodyAnchorChild" in l) and "Squidward" in l and not stripped.startswith("//"):
        new_l = l.replace(CURLY, STRAIGHT)
        if new_l != l:
            print(f"Fixed line {i+1}: {new_l.strip()[:80]}")
            lines[i] = new_l
            changed += 1

if changed > 0:
    with open(path, "w", encoding="utf-8") as f:
        f.writelines(lines)
    print(f"Written {changed} line(s)")
else:
    print("No curly apostrophes found in data lines. Current codepoints:")
    for i, l in enumerate(lines):
        stripped = l.lstrip()
        if "bodyAnchorChild" in l and "Squidward" in l and not stripped.startswith("//"):
            idx = l.index("Squidward")
            cp = ord(l[idx + 9])
            print(f"line {i+1} cp: {cp:#06x} ({repr(chr(cp))})")
