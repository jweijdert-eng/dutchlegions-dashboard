#!/usr/bin/env python3
"""Genereert de gebundelde SDE-data in public/ uit de EVE Ref reference-data export.
Draai: python tools/build-sde.py  (daarna committen + pushen)

Output (compact, meegedeployd met de site → geen lokale server nodig):
  public/blueprints.json  { bpId: { m:[[matId,qty],...], p:[prodId,qty] } }   (manufacturing)
  public/type-names.json  { typeId: "Naam" }                                  (published types, en)
  public/schematics.json  { id: { schematic_name, cycle_time, pins:[{type_id,is_input,quantity}] } } (PI)
"""
import io, json, sys, tarfile, urllib.request, os

URL = 'https://data.everef.net/reference-data/reference-data-latest.tar.xz'
PUB = os.path.join(os.path.dirname(__file__), '..', 'public')

print('Downloaden EVE Ref reference-data (~14MB)...')
data = urllib.request.urlopen(URL, timeout=180).read()
tar = tarfile.open(fileobj=io.BytesIO(data), mode='r:xz')

def load(name):
    return json.load(io.TextIOWrapper(tar.extractfile(name), encoding='utf-8'))

def write(name, obj):
    p = os.path.join(PUB, name)
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
    print(f'  {name}: {len(obj)} entries, {os.path.getsize(p)} bytes')

# Blueprints (manufacturing)
bp = load('blueprints.json')
out_bp = {}
for bid, b in bp.items():
    mfg = (b.get('activities') or {}).get('manufacturing')
    if not mfg:
        continue
    prods = mfg.get('products') or {}
    if not prods:
        continue
    prod = next(iter(prods.values()))
    out_bp[bid] = {
        'm': [[m['type_id'], m['quantity']] for m in (mfg.get('materials') or {}).values()],
        'p': [prod['type_id'], prod['quantity']],
    }
write('blueprints.json', out_bp)

# Type-namen (published, Engels)
types = load('types.json')
out_names = {tid: t['name']['en'] for tid, t in types.items()
             if t.get('published') and (t.get('name') or {}).get('en')}
write('type-names.json', out_names)

# PI-schematics → ESI Schematic-vorm
sch = load('schematics.json')
out_sch = {}
for sid, s in sch.items():
    pins = [{'type_id': m['type_id'], 'is_input': True, 'quantity': m['quantity']}
            for m in (s.get('materials') or {}).values()]
    pins += [{'type_id': p['type_id'], 'is_input': False, 'quantity': p['quantity']}
             for p in (s.get('products') or {}).values()]
    out_sch[sid] = {'schematic_name': s['name']['en'], 'cycle_time': s['cycle_time'], 'pins': pins}
write('schematics.json', out_sch)

print('Klaar.')
