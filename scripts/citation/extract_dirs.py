with open('/tmp/cited_sources.txt') as f:
    for line in f:
        s = line.strip()
        if s.endswith('/'):
            print(s.rstrip('/'))