"""
Read <repo>/Firefox/vendor/plantuml.js and produce a new .js file
containing ONLY the lines that do NOT start with a space or a tab.
"""

from pathlib import Path

# This script lives in <repo>/Firefox and reads/writes inside <repo>/Firefox/vendor.
FIREFOX_DIR = Path(__file__).resolve().parent
INPUT_PATH = FIREFOX_DIR / "vendor" / "plantuml.js"
OUTPUT_PATH = INPUT_PATH.with_name("plantuml.filtered.js")


def filter_lines(input_path: Path, output_path: Path) -> None:
    kept = 0
    total = 0
    # newline="" to preserve original line endings as-is
    with input_path.open("r", encoding="utf-8", newline="") as fin, \
         output_path.open("w", encoding="utf-8", newline="") as fout:
        for line in fin:
            total += 1
            # Look at the very first character of the raw line.
            # An empty line ("") or one containing only "\n" has no
            # leading space/tab -> we keep it too.
            if line and line[0] in (" ", "\t"):
                continue
            fout.write(line)
            kept += 1

    print(f"Read    : {input_path}")
    print(f"Written : {output_path}")
    print(f"Lines   : {kept} kept / {total} total")


if __name__ == "__main__":
    if not INPUT_PATH.exists():
        raise SystemExit(f"File not found: {INPUT_PATH}")
    filter_lines(INPUT_PATH, OUTPUT_PATH)
