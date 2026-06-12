import json
import urllib.request

url = 'https://esi.evetech.net/latest/swagger.json'
with urllib.request.urlopen(url) as resp:
    data = json.load(resp)

for path in sorted(data['paths']):
    if any(term in path for term in ('route', 'waypoints', 'navigation', 'nav')):
        print(path)
