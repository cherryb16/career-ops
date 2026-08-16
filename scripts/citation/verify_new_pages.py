import yaml
from pathlib import Path

wiki_root = Path('/Users/mac_studio/Library/Mobile Documents/iCloud~md~obsidian/Documents/Notes/Wiki')

# Check the new pages have valid frontmatter and sources
new_pages = [
    'entities/fin-201.md',
    'entities/strat-412-grocery-analysis.md',
    'concepts/generational-poverty.md',
    'concepts/sql-study-guide.md',
    'entities/econ-381.md'
]

for page in new_pages:
    p = wiki_root / page
    content = p.read_text()
    if content.startswith('---'):
        fm_end = content.index('---', 3)
        fm = yaml.safe_load(content[3:fm_end])
        print(f'{page}: type={fm.get("type")}, tags={fm.get("tags")}, sources={len(fm.get("sources", []))}')
        for s in fm.get('sources', []):
            exists = (wiki_root / s).exists()
            print(f'  {s} -> {"EXISTS" if exists else "MISSING"}')
    else:
        print(f'{page}: NO FRONTMATTER')