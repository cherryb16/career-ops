import os
import yaml
from pathlib import Path

wiki_root = Path("/Users/mac_studio/Library/Mobile Documents/iCloud~md~obsidian/Documents/Notes/Wiki")

# Get all raw files
raw_root = wiki_root / "raw" / "notes"
raw_files = set()
for f in raw_root.rglob("*.md"):
    raw_files.add(str(f.relative_to(wiki_root)))

print(f"Total raw .md files: {len(raw_files)}")

# Get all cited sources from entity/concept pages
def parse_frontmatter(content: str):
    if not content.startswith('---'):
        return {}
    end = content.find('---', 3)
    if end < 0:
        return {}
    try:
        return yaml.safe_load(content[3:end]) or {}
    except yaml.YAMLError:
        return {}

cited_sources = set()
for folder in ["entities", "concepts", "comparisons", "queries"]:
    folder_path = wiki_root / folder
    if not folder_path.exists():
        continue
    for f in folder_path.glob("*.md"):
        try:
            content = f.read_text(encoding='utf-8')
            fm = parse_frontmatter(content)
            sources = fm.get('sources', [])
            if sources:
                for s in sources:
                    cited_sources.add(s)
        except Exception as e:
            pass

print(f"Unique cited sources: {len(cited_sources)}")

# Check which cited sources don't exist
missing = []
for s in cited_sources:
    if s not in raw_files:
        missing.append(s)

print(f"Missing/broken citations: {len(missing)}")
for m in missing:
    print(f"  MISSING: {m}")

# Uncited raw files
uncited = raw_files - cited_sources
print(f"\nUncited raw files: {len(uncited)}")

# Group uncited by directory
from collections import defaultdict
uncited_by_dir = defaultdict(list)
for f in sorted(uncited):
    parts = f.split('/')
    if len(parts) >= 3:
        key = '/'.join(parts[:3])
    else:
        key = '/'.join(parts[:2])
    uncited_by_dir[key].append(f)

print("\nUncited files by source directory:")
for dir_key, files in sorted(uncited_by_dir.items(), key=lambda x: -len(x[1])):
    print(f"  {dir_key}: {len(files)} files")
    if len(files) <= 5:
        for f in files:
            print(f"    {f}")
    else:
        for f in files[:3]:
            print(f"    {f}")
        print(f"    ... and {len(files) - 3} more")