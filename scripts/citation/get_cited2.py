import yaml, re, sys, os

wiki_path = "/Users/mac_studio/Library/Mobile Documents/iCloud~md~obsidian/Documents/Notes/Wiki"
os.chdir(wiki_path)

sources = set()

# Walk all entity and concept files
for root, dirs, files in os.walk('entities'):
    for f in files:
        if f.endswith('.md'):
            path = os.path.join(root, f)
            try:
                with open(path) as fp:
                    content = fp.read()
                    # Find the frontmatter block
                    if content.startswith('---'):
                        end = content.find('\n---', 3)
                        if end > 0:
                            frontmatter = content[3:end].strip()
                            fm = yaml.safe_load(frontmatter)
                            if fm and 'sources' in fm:
                                for item in fm['sources']:
                                    sources.add(item.strip())
            except:
                pass

for root, dirs, files in os.walk('concepts'):
    for f in files:
        if f.endswith('.md'):
            path = os.path.join(root, f)
            try:
                with open(path) as fp:
                    content = fp.read()
                    if content.startswith('---'):
                        end = content.find('\n---', 3)
                        if end > 0:
                            frontmatter = content[3:end].strip()
                            fm = yaml.safe_load(frontmatter)
                            if fm and 'sources' in fm:
                                for item in fm['sources']:
                                    sources.add(item.strip())
            except:
                pass

for s in sorted(sources):
    print(s)