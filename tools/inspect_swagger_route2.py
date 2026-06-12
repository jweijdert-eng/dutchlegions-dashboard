import json
import urllib.request

url = 'https://esi.evetech.net/latest/swagger.json'
with urllib.request.urlopen(url) as resp:
    data = json.load(resp)

for path in sorted(data['paths']):
    if 'route' in path or 'Route' in path or 'waypoints' in path or 'navigation' in path or 'nav' in path:
        print(path)
