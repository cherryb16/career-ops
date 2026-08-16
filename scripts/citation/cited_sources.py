import yaml
import sys
from pathlib import Path

wiki_root = Path('/Users/mac_studio/Library/Mobile Documents/iCloud~md~obsidian/Documents/Notes/Wiki')
entities_dir = wiki_root / 'entities'
concepts_dir = wiki_root / 'concepts'

cited_sources = set()
for page_dir in [entities_dir, concepts_dir]:
    if page_dir.exists():
        for page_file in page_dir.glob('*.md'):
            content = page_file.read_text()
            if content.startswith('---'):
                try:
                    fm_end = content.index('---', 3)
                    frontmatter = yaml.safe_load(content[3:fm_end])
                    if frontmatter and 'sources' in frontmatter:
                        for src in frontmatter['sources']:
                            cited_sources.add(src)
                except:
                    pass

print(f'Total cited sources: {len(cited_sources)}')
for src in sorted(cited_sources):
    print(f'  {src}')