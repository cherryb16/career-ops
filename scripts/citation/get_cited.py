import yaml, re, sys, os

wiki_path = "/Users/mac_studio/Library/Mobile Documents/iCloud~md~obsidian/Documents/Notes/Wiki"
os.chdir(wiki_path)

# Get cited sources from frontmatter using grep
import subprocess
result = subprocess.run(['grep', '-h', 'sources:', 'entities/*.md', 'concepts/*.md'], capture_output=True, text=True)
lines = result.stdout.strip().split('\n')

sources = set()
for line in lines:
    line = line.strip()
    match = re.search(r'sources:\s*(\[.*?\])', line)
    if match:
        try:
            items = yaml.safe_load(match.group(1))
            if items:
                for item in items:
                    sources.add(item.strip())
        except:
            pass

for s in sorted(sources):
    print(s)