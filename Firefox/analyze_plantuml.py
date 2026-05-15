"""
Analyse the structure of plantuml.filtered.js to understand where the
natural top-level boundaries are. A "boundary" here is a line that ends
with a single ';' AND is at column 0 (the filtered file only has
column-0 lines, so all of them count).

Then map those boundaries back to byte offsets in the ORIGINAL
plantuml.js file by counting bytes per line in the original file up to
each boundary line number.

Strategy:
  1. Walk plantuml.filtered.js, build (filtered_line_no, line) tuples
     where line ends with ';'.
  2. We need the line numbers IN THE ORIGINAL FILE, not in the filtered
     one. The filter dropped indented lines but kept their position
     implicit. So we walk the original file in parallel and track which
     ORIGINAL line each kept line came from.
"""

from pathlib import Path

# This script lives in <repo>/Firefox and reads from <repo>/Firefox/vendor.
FIREFOX_DIR = Path(__file__).resolve().parent
VENDOR = FIREFOX_DIR / "vendor"
ORIG = VENDOR / "plantuml.js"
FILTERED = VENDOR / "plantuml.filtered.js"

orig_size = ORIG.stat().st_size
filt_size = FILTERED.stat().st_size
print(f"Original size:  {orig_size / 1024 / 1024:.2f} MB")
print(f"Filtered size:  {filt_size / 1024 / 1024:.2f} MB")

# Walk the original file and record, for each line, its byte offset.
# We'll need this to know where each "kept" line lives in the original.
print("\nScanning original file for line offsets...")
orig_line_offsets = []  # orig_line_offsets[i] = byte offset of (1-indexed) line i+1
orig_lines = []         # raw original lines (we'll need them to detect "kept" ones)
offset = 0
with ORIG.open("r", encoding="utf-8", newline="") as f:
    for line in f:
        orig_line_offsets.append(offset)
        orig_lines.append(line)
        offset += len(line.encode("utf-8"))
total_orig_lines = len(orig_lines)
print(f"Original has {total_orig_lines} lines")

# Apply the same filter logic and find boundary points
# A boundary is a kept line whose stripped form ends in ';'
boundaries = []  # list of (orig_line_no, byte_offset, preview)
for i, line in enumerate(orig_lines):
    if line and line[0] in (" ", "\t"):
        continue  # filtered out
    stripped = line.rstrip()
    if stripped.endswith(";") and not stripped.endswith(",;"):
        # This is a top-level statement terminator
        # byte offset is offset of the START of the NEXT line (i.e. boundary AFTER this line)
        if i + 1 < len(orig_lines):
            boundary_offset = orig_line_offsets[i + 1]
        else:
            boundary_offset = orig_size
        boundaries.append((i + 1, boundary_offset, stripped[:80]))

print(f"\nFound {len(boundaries)} top-level statement boundaries")

# Show first 10 and last 10
print("\nFirst 10 boundaries:")
for b in boundaries[:10]:
    print(f"  orig line {b[0]:>7}, byte offset {b[1] / 1024 / 1024:>6.2f} MB  | {b[2]}")
print("\nLast 10 boundaries:")
for b in boundaries[-10:]:
    print(f"  orig line {b[0]:>7}, byte offset {b[1] / 1024 / 1024:>6.2f} MB  | {b[2]}")

# Distribution: how big is each gap between boundaries?
print("\nGap sizes (top 20 largest gaps between consecutive boundaries):")
gaps = []
prev_offset = 0
for line_no, offset, preview in boundaries:
    gap = offset - prev_offset
    gaps.append((gap, line_no, offset, preview))
    prev_offset = offset
final_gap = orig_size - prev_offset
gaps.append((final_gap, total_orig_lines, orig_size, "<EOF>"))

gaps_sorted = sorted(gaps, key=lambda g: -g[0])
for g in gaps_sorted[:20]:
    print(f"  gap = {g[0] / 1024 / 1024:>6.2f} MB, ending at orig line {g[1]:>7} (offset {g[2] / 1024 / 1024:.2f} MB)")
    print(f"      ...{g[3]}")

# Compute proposed split into N chunks under 4 MB each
LINTER_LIMIT = 5 * 1024 * 1024
SAFE = 4 * 1024 * 1024  # target chunk size
n_chunks = (orig_size + SAFE - 1) // SAFE
print(f"\n=== Proposed split into {n_chunks} chunks of up to {SAFE / 1024 / 1024:.1f} MB ===")

# Greedy: accumulate boundaries until we'd exceed SAFE, then split at the previous boundary
splits = []
chunk_start = 0
i = 0
while i < len(boundaries):
    line_no, offset, preview = boundaries[i]
    if offset - chunk_start > SAFE and splits and splits[-1] != (chunk_start, line_no, offset, preview):
        # back off to the previous boundary
        prev_line, prev_offset, prev_preview = boundaries[i - 1]
        splits.append((chunk_start, prev_line, prev_offset, prev_preview))
        chunk_start = prev_offset
    i += 1
# add final segment
splits.append((chunk_start, total_orig_lines, orig_size, "<EOF>"))

print(f"\nFinal split: {len(splits)} chunks")
for idx, (start_off, end_line, end_off, preview) in enumerate(splits):
    size = (end_off - start_off) / 1024 / 1024
    over = "  *** OVER 5MB ***" if (end_off - start_off) > LINTER_LIMIT else ""
    print(f"  chunk {idx}: orig offset {start_off / 1024 / 1024:.2f}..{end_off / 1024 / 1024:.2f} MB (size {size:.2f} MB){over}")
    print(f"            ends at orig line {end_line}: {preview}")
