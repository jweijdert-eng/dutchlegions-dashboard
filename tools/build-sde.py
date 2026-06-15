#!/usr/bin/env python3
"""Genereert de gebundelde SDE-data in public/ uit de EVE Ref reference-data export.
Draai: python tools/build-sde.py  (daarna committen + pushen)

Output (compact, meegedeployd met de site → geen lokale server nodig):
  public/blueprints.json  { bpId: { m:[[matId,qty],...], p:[prodId,qty] } }   (manufacturing)
  public/type-names.json  { typeId: "Naam" }                                  (published types, en)
  public/schematics.json  { id: { schematic_name, cycle_time, pins:[{type_id,is_input,quantity}] } } (PI)
"""
import io, json, tarfile, urllib.request, os, gzip, sqlite3, tempfile
from datetime import datetime, timezone

URL = 'https://data.everef.net/reference-data/reference-data-latest.tar.xz'
LATEST = 'https://developers.eveonline.com/static-data/tranquility/latest.jsonl'
FUZZ = 'https://www.fuzzwork.co.uk/dump/latest-sqlite.db.gz'
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

# ── Fuzzwork SQLite (klassieke SDE) → systems / stations / type-info / reprocessing ──
# LET OP: decomprimeer met Python's gzip; git-bash 'gunzip' levert hier een onbruikbaar bestand.
print('Downloaden Fuzzwork SDE SQLite (~136MB)...')
gz = urllib.request.urlopen(FUZZ, timeout=600).read()
db_path = os.path.join(tempfile.gettempdir(), 'fuzzwork-sde.db')
with open(db_path, 'wb') as f:
    f.write(gzip.decompress(gz))
con = sqlite3.connect(db_path)

# Solar systems: { systemId: [naam, security, regionId] }
# 4 decimalen → de app rondt zelf naar 1 decimaal (anders dubbel afronden: Jita 0.9459 → 0.95 → 1.0).
out_sys = {str(sid): [name, round(sec, 4), rid]
           for sid, name, sec, rid in con.execute(
               'SELECT solarSystemID, solarSystemName, security, regionID FROM mapSolarSystems')}
write('systems.json', out_sys)

# Regio's: { regionId: naam }
out_reg = {str(rid): name for rid, name in con.execute('SELECT regionID, regionName FROM mapRegions')}
write('regions.json', out_reg)

# Systeem-coördinaten voor de New Eden cluster-kaart: { systemId: [x, z] }
# (top-down, /1e12 afgerond). Alleen k-space (id < 31000000); wormhole/J-space ligt
# op heel andere coords en zou de cluster-vorm vervormen.
out_xy = {str(sid): [round(x / 1e12), round(z / 1e12)]
          for sid, x, z in con.execute('SELECT solarSystemID, x, z FROM mapSolarSystems WHERE solarSystemID < 31000000')}
write('system-coords.json', out_xy)

# Stargate-buren: { systemId: [buurSystemId, ...] } — voor jump-afstand (BFS).
adj = {}
for a, b in con.execute('SELECT fromSolarSystemID, toSolarSystemID FROM mapSolarSystemJumps'):
    adj.setdefault(str(a), []).append(b)
write('system-jumps.json', adj)

# NPC-stations: { stationId: [naam, systemId] }
# (Productie-capaciteit zit niet in deze SDE-dump; de app checkt de 'services' van
#  een station live via ESI /universe/stations/{id}/ wanneer een systeem gekozen is.)
out_sta = {str(sid): [name, sysid]
           for sid, name, sysid in con.execute(
               'SELECT stationID, stationName, solarSystemID FROM staStations')}
write('stations.json', out_sta)

# Type-info: { typeId: [groupId, volume, portionSize] }  — SP-per-categorie, m³, reprocessing-batch
out_ti = {str(tid): [gid, vol, portion]
          for tid, gid, vol, portion in con.execute(
              'SELECT typeID, groupID, volume, portionSize FROM invTypes')}
write('type-info.json', out_ti)

# Groepen: { groupId: [naam, categoryId] }
out_grp = {str(gid): [name, cid]
           for gid, name, cid in con.execute('SELECT groupID, groupName, categoryID FROM invGroups')}
write('groups.json', out_grp)

# Categorieën: { categoryId: naam }
out_cat = {str(cid): name for cid, name in con.execute('SELECT categoryID, categoryName FROM invCategories')}
write('categories.json', out_cat)

# Reprocessing-opbrengst: { typeId: [[materiaalId, aantal], ...] }
out_rep = {}
for tid, mid, qty in con.execute(
        'SELECT typeID, materialTypeID, quantity FROM invTypeMaterials ORDER BY typeID'):
    out_rep.setdefault(str(tid), []).append([mid, qty])
write('reprocess.json', out_rep)

con.close()

# SDE-versie (officiële build) — voor weergave + update-detectie
ver = json.loads(urllib.request.urlopen(LATEST, timeout=30).read().decode().splitlines()[0])
version = {
    'build': ver.get('buildNumber'),
    'releaseDate': ver.get('releaseDate'),
    'generatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
}
with open(os.path.join(PUB, 'sde-version.json'), 'w', encoding='utf-8') as f:
    json.dump(version, f, ensure_ascii=False)
print(f'  sde-version.json: build #{version["build"]} ({version["releaseDate"]})')

print('Klaar.')
