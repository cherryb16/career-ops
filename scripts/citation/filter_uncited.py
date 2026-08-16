import sys, os

cited_dirs = set()
with open('/tmp/cited_dirs.txt') as f:
    for line in f:
        d = line.strip()
        if d:
            cited_dirs.add(d)

uncited = []
with open('/tmp/uncited.txt') as f:
    for line in f:
        fpath = line.strip()
        if not fpath:
            continue
        # Check if this file is under any cited directory
        under_cited = False
        for cd in cited_dirs:
            if fpath.startswith(cd + '/') or fpath == cd:
                under_cited = True
                break
        if not under_cited:
            uncited.append(fpath)

with open('/tmp/uncited_filtered.txt', 'w') as f:
    for u in uncited:
        f.write(u + '\n')

print(len(uncited))