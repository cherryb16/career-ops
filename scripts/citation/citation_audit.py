import os
import re

# Find all .md files under raw/notes
raw_files = set()
for root, dirs, files in os.walk("/Users/mac_studio/Library/Mobile Documents/iCloud~md~obsidian/Documents/Notes/Wiki/raw/notes"):
    for f in files:
        if f.endswith('.md'):
            full_path = os.path.join(root, f)
            rel_path = os.path.relpath(full_path, "/Users/mac_studio/Library/Mobile Documents/iCloud~md~obsidian/Documents/Notes/Wiki")
            raw_files.add(rel_path)

print(f"Total raw .md files: {len(raw_files)}")

# Read all entity and concept pages to extract sources
cited_sources = set()

for base in ["/Users/mac_studio/Library/Mobile Documents/iCloud~md~obsidian/Documents/Notes/Wiki/entities", "/Users/mac_studio/Library/Mobile Documents/iCloud~md~obsidian/Documents/Notes/Wiki/concepts"]:
    for root, dirs, files in os.walk(base):
        for f in files:
            if f.endswith('.md'):
                full_path = os.path.join(root, f)
                try:
                    with open(full_path, 'r') as fp:
                        content = fp.read()
                        # Extract sources: YAML array format with quotes
                        sources_match = re.search(r'sources:\s*(\[.*?\])', content, re.DOTALL)
                        if sources_match:
                            sources_str = sources_match.group(1)
                            # Parse array items with quotes
                            items = re.findall(r'"([^"]+)"', sources_str)
                            for item in items:
                                cited = item.strip()
                                if cited:
                                    cited_sources.add(cited)
                        # Also check for YAML array without quotes (comma-separated)
                        sources_match2 = re.search(r'sources:\s*(\[.*?\])', content, re.DOTALL)
                        if sources_match2:
                            items = re.findall(r'([^,\[\]]+)', sources_match2.group(1))
                            for item in items:
                                cited = item.strip().strip('"\'')
                                if cited:
                                    cited_sources.add(cited)
                except Exception as e:
                    print(f"Error reading {full_path}: {e}")

print(f"Total unique cited sources: {len(cited_sources)}")

# Also check index.md for wikilinks
index_path = "/Users/mac_studio/Library/Mobile Documents/iCloud~md~obsidian/Documents/Notes/Wiki/index.md"
try:
    with open(index_path, 'r') as fp:
        content = fp.read()
        wikilinks = re.findall(r'\[\[([^\]]+)\]\]', content)
        print(f"Wikilinks in index.md: {len(wikilinks)}")
except Exception as e:
    print(f"Error reading index.md: {e}")

# Check log.md for processed sources
log_path = "/Users/mac_studio/Library/Mobile Documents/iCloud~md~obsidian/Documents/Notes/Wiki/log.md"
try:
    with open(log_path, 'r') as fp:
        content = fp.read()
        # Extract source paths mentioned in log
        log_sources = re.findall(r'`(raw/notes/[^`]+)`', content)
        print(f"Source paths mentioned in log.md: {len(set(log_sources))}")
except Exception as e:
    print(f"Error reading log.md: {e}")

# Find uncited raw files
uncited = raw_files - cited_sources
print(f"\nUncited raw files: {len(uncited)}")

# Filter out artifacts (empty files, templates, etc.)
substantive_uncited = []
for f in sorted(uncited):
    full = os.path.join("/Users/mac_studio/Library/Mobile Documents/iCloud~md~obsidian/Documents/Notes/Wiki", f)
    try:
        size = os.path.getsize(full)
        if size > 100:  # Only consider files > 100 bytes
            with open(full, 'r') as fp:
                content = fp.read()
                if len(content.strip()) > 50:  # Has actual content
                    substantive_uncited.append((f, size, len(content)))
    except:
        pass

print(f"Substantive uncited files (>100 bytes, >50 chars): {len(substantive_uncited)}")

# Group by directory
from collections import defaultdict
by_dir = defaultdict(list)
for f, size, clen in substantive_uncited:
    dir_name = os.path.dirname(f)
    by_dir[dir_name].append((f, size, clen))

print("\n=== Substantive Uncited Files by Directory ===")
for dir_name, files in sorted(by_dir.items(), key=lambda x: -len(x[1])):
    print(f"\n{dir_name} ({len(files)} files):")
    for f, size, clen in sorted(files, key=lambda x: -x[1])[:10]:  # Top 10 by size
        print(f"  {f} ({size} bytes, {clen} chars)")
    if len(files) > 10:
        print(f"  ... and {len(files) - 10} more")