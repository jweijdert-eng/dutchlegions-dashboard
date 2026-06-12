import json
import urllib.request

url = 'https://esi.evetech.net/latest/swagger.json'
with urllib.request.urlopen(url) as resp:
    data = json.load(resp)

for path, item in data['paths'].items():
    if 'navigation' in path or 'nav' in path:
        print(path)
        for method, op in item.items():
            print(' ', method, op.get('summary', ''))
            for p in op.get('parameters', []):
                print('   param', p.get('name'), p.get('in'), p.get('schema', {}).get('type'), p.get('required', False), p.get('description', ''))
