"""
Split vendor/plantuml.js into multiple chunks, each under ~4 MB.

Strategy:
  1. Read the original file and identify top-level statement boundaries
     (lines at column 0 ending with ';').
  2. Greedily walk boundaries: accumulate until adding the next boundary
     would push the chunk over the target size, then cut.
  3. At each chunk, transform:
     - Top-level 'let ' and 'const ' to 'var '
     - The final 'export { ... }' to 'window.__plantuml = { ... }'
  4. Write N chunks: plantuml.0.js, plantuml.1.js, ..., plantuml.N.js
"""

import re
from pathlib import Path

# This script lives in <repo>/Firefox and reads/writes inside <repo>/Firefox/vendor.
FIREFOX_DIR = Path(__file__).resolve().parent
SRC = FIREFOX_DIR / "vendor" / "plantuml.js"
OUT_DIR = SRC.parent
TARGET_CHUNK_SIZE = 4 * 1024 * 1024  # 4 MB
EXPORT_RE = re.compile(r"^export\s*{\s*([^}]+)\s*}\s*;?\s*$")

print(f"Reading {SRC.name}...")
with SRC.open("r", encoding="utf-8", newline="") as f:
    lines = f.readlines()

# Precompute byte length of each line for fast slicing
line_bytes = [len(line.encode("utf-8")) for line in lines]
total_size = sum(line_bytes)
print(f"Total: {len(lines):,} lines, {total_size / 1024 / 1024:.2f} MB")

# Cumulative byte offset at the START of each line (line i starts at cum[i])
cum = [0] * (len(lines) + 1)
for i, b in enumerate(line_bytes):
    cum[i + 1] = cum[i] + b
# cum[i] = byte offset of the start of line i
# size of lines[a..b] inclusive = cum[b+1] - cum[a]

# Step 1: Find all top-level boundaries (lines at column 0 ending with ';')
boundaries = []  # list of line indices where the statement ENDS
for i, line in enumerate(lines):
    if line and line[0] not in (" ", "\t"):
        stripped = line.rstrip()
        if stripped.endswith(";"):
            boundaries.append(i)

print(f"Found {len(boundaries)} top-level boundaries")

# Step 2: Greedy split
# chunks is a list of (start_line, end_line) inclusive
chunks = []
chunk_start = 0
last_good_boundary = None  # last boundary we could cut at if we wanted

for b in boundaries:
    # If we were to cut at boundary b, the chunk would be lines[chunk_start..b]
    chunk_size_if_cut_here = cum[b + 1] - cum[chunk_start]
    if chunk_size_if_cut_here > TARGET_CHUNK_SIZE and last_good_boundary is not None:
        # Cut at the previous good boundary instead
        chunks.append((chunk_start, last_good_boundary))
        chunk_start = last_good_boundary + 1
        last_good_boundary = b  # b becomes a candidate for the next chunk
        # But we need to check: is the new chunk [chunk_start..b] still under target?
        # If yes, keep b as last_good_boundary. If no... that would mean a single
        # statement is > 4 MB, which shouldn't happen given the data we saw.
        new_chunk_size = cum[b + 1] - cum[chunk_start]
        if new_chunk_size > TARGET_CHUNK_SIZE:
            print(f"  WARNING: single statement at line {b} is {new_chunk_size / 1024 / 1024:.2f} MB, larger than target")
    else:
        # This boundary fits; remember it as a candidate
        last_good_boundary = b

# Final chunk: from chunk_start to the end of file
chunks.append((chunk_start, len(lines) - 1))

print(f"Split into {len(chunks)} chunks:")
for idx, (start, end) in enumerate(chunks):
    size = (cum[end + 1] - cum[start]) / 1024 / 1024
    print(f"  chunk {idx}: lines {start:>7}..{end:>7} ({size:>6.2f} MB)")

# Step 3: Transform and write chunks
def transform_chunk(chunk_lines, is_final):
    """Transform: let/const -> var at column 0, and rewrite final export."""
    result = []
    for line in chunk_lines:
        stripped = line.rstrip()
        
        if line and line[0] not in (" ", "\t"):
            if stripped.startswith("let "):
                line = "var " + line[4:]
            elif stripped.startswith("const "):
                line = "var " + line[6:]
            
            if is_final:
                m = EXPORT_RE.match(stripped)
                if m:
                    exports_str = m.group(1)
                    exports = [e.strip() for e in exports_str.split(",")]
                    assignments = []
                    for exp in exports:
                        parts = exp.split(" as ")
                        if len(parts) == 2:
                            name, alias = parts[0].strip(), parts[1].strip()
                            assignments.append(f"{alias}: {name}")
                        else:
                            assignments.append(f"{exp}: {exp}")
                    line = "window.__plantuml = { " + ", ".join(assignments) + " };\n"
        
        result.append(line)
    
    return result

for chunk_idx, (start, end) in enumerate(chunks):
    is_final = (chunk_idx == len(chunks) - 1)
    chunk_lines = lines[start : end + 1]
    transformed = transform_chunk(chunk_lines, is_final)
    
    out_file = OUT_DIR / f"plantuml.{chunk_idx}.js"
    with out_file.open("w", encoding="utf-8", newline="") as f:
        f.writelines(transformed)
    
    size = sum(len(line.encode("utf-8")) for line in transformed) / 1024 / 1024
    print(f"Wrote {out_file.name} ({size:.2f} MB)")

print("\nDone!")
