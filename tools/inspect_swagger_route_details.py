import json
import urllib.request

url = 'https://esi.evetech.net/latest/swagger.json'
with urllib.request.urlopen(url) as resp:
    data = json.load(resp)
path = '/route/{origin}/{destination}/'
item = data['paths'].get(path)
if item is None:
    print('PATH_NOT_FOUND')
else:
    print(json.dumps(item, indent=2))
