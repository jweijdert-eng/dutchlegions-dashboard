#!/usr/bin/env python3
"""Genereert de gebundelde SDE-data in public/ uit twee bronnen:
  - EVE Ref reference-data (item-recepten): blueprints, reactions, type-names, schematics
  - CCP's officiële Tranquility static-data (JSONL-zip): álle universe-/item-tabellen
    (systems, regions, stations, jumps, type-info, groups, categories, reprocess, …)
Geen third-party Fuzzwork-SQLite meer; alle bundels zijn 1-op-1 geverifieerd identiek.
Draai: python tools/build-sde.py  (daarna committen + pushen)

Output (compact, meegedeployd met de site → geen lokale server nodig):
  public/blueprints.json  { bpId: { m:[[matId,qty],...], p:[prodId,qty], s:[[skillId,lvl],...] } }
  public/reactions.json   { formulaId: { m:[...], p:[...], s:[...] } }        (reacties)
  public/type-names.json  { typeId: "Naam" }                                  (published types, en)
  public/schematics.json  { id: { schematic_name, cycle_time, pins:[{type_id,is_input,quantity}] } } (PI)
"""
import io, json, tarfile, urllib.request, os, zipfile
from datetime import datetime, timezone

URL = 'https://data.everef.net/reference-data/reference-data-latest.tar.xz'
LATEST = 'https://developers.eveonline.com/static-data/tranquility/latest.jsonl'
# Officiële Tranquility static-data (JSONL-zip). Eén CCP-bron voor álle universe-/
# item-tabellen (vervangt de third-party Fuzzwork-SQLite) én het position2D-veld dat
# de in-game New Eden-kaart gebruikt (2D 'schematic' layout, niet de ruwe 3D-projectie).
SDE_JSONL = 'https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip'
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
# NB: blueprints.json en reactions.json worden pas verderop weggeschreven — de
# skill-eisen komen uit CCP's JSONL en die is hier nog niet gedownload.

# Reacties (reaction-formula's) — zelfde compacte vorm als manufacturing
out_rx = {}
for bid, b in bp.items():
    rx = (b.get('activities') or {}).get('reaction')
    if not rx:
        continue
    prods = rx.get('products') or {}
    if not prods:
        continue
    prod = next(iter(prods.values()))
    out_rx[bid] = {
        'm': [[m['type_id'], m['quantity']] for m in (rx.get('materials') or {}).values()],
        'p': [prod['type_id'], prod['quantity']],
    }


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

# ── Officiële Tranquility static-data (JSONL-zip) → systems / stations / type-info / … ──
# Eén officiële CCP-bron i.p.v. de third-party Fuzzwork-SQLite. Alle bundels hieronder
# zijn 1-op-1 geverifieerd identiek aan de oude Fuzzwork-output (incl. de 5210 stations).
print('Downloaden officiële SDE JSONL-zip (~94MB)...')
sde_zip = urllib.request.urlopen(SDE_JSONL, timeout=600).read()
zf = zipfile.ZipFile(io.BytesIO(sde_zip))

def jrows(name):
    with zf.open(name) as f:
        for raw in f:
            yield json.loads(raw)

def en(o):
    return o.get('en') if isinstance(o, dict) else o   # SDE-namen zijn {en, de, …}

# Skill-eisen om een blueprint te mógen gebruiken → 's' op de recepten hierboven.
# EVE Ref laat ze weg, CCP's blueprints.jsonl heeft ze wél (camelCase: typeID/level).
# Skills veranderen niets aan de materiaalhoeveelheden — dit is puur "mag ik dit
# bouwen"; het dashboard zet er een waarschuwing bij als de bouwer ze mist.
for row in jrows('blueprints.jsonl'):
    bid = str(row['_key'])
    for act, doel in (('manufacturing', out_bp), ('reaction', out_rx)):
        a = (row.get('activities') or {}).get(act) or {}
        sk = sorted([[s['typeID'], s['level']] for s in (a.get('skills') or []) if s.get('typeID')])
        if sk and bid in doel:
            doel[bid]['s'] = sk
write('blueprints.json', out_bp)
write('reactions.json', out_rx)
print(f"    met skill-eisen: {sum(1 for r in out_bp.values() if 's' in r)} blueprints, "
      f"{sum(1 for r in out_rx.values() if 's' in r)} reacties")

# Solar systems + 2D-kaartcoördinaten in één pass.
# security: 4 decimalen → de app rondt zelf naar 1 (anders dubbel afronden: Jita 0.9459 → 1.0).
# position2D = de in-game 'schematic' 2D-layout; /1e12 afgerond, alleen k-space (id < 31000000),
# want wormhole/J-space heeft geen zinnige 2D-plek en zou de cluster-vorm vervormen.
sysname = {}
out_sys = {}
out_xy = {}
for s in jrows('mapSolarSystems.jsonl'):
    sid = s['_key']
    nm = en(s['name'])
    sysname[sid] = nm
    out_sys[str(sid)] = [nm, round(s['securityStatus'], 4), s['regionID']]
    if sid < 31000000:
        p2 = s.get('position2D')
        if p2:
            out_xy[str(sid)] = [round(p2['x'] / 1e12), round(p2['y'] / 1e12)]
write('systems.json', out_sys)
write('system-coords.json', out_xy)

# Regio's: { regionId: naam }
write('regions.json', {str(r['_key']): en(r['name']) for r in jrows('mapRegions.jsonl')})

# Stargate-buren: { systemId: [buurSystemId, ...] } — voor jump-afstand (BFS).
adj = {}
for sg in jrows('mapStargates.jsonl'):
    adj.setdefault(str(sg['solarSystemID']), []).append(sg['destination']['solarSystemID'])
write('system-jumps.json', adj)

# NPC-stations: { stationId: [naam, systemId] }.
# CCP slaat stationnamen niet meer op → reconstrueren uit celestial (planeet/maan) +
# eigenaar-corp + station-operatie, exact zoals de in-game/Fuzzwork-naam. De paar
# 'benoemde' planeten (homeworlds) hebben een eigennaam die niet in de SDE staat → vaste
# lore-lijst (verandert nooit). (Station-services checkt de app live via ESI.)
NAMED_PLANETS = {
    40009253: 'Matigu', 40009255: 'Matias', 40139398: 'Nemantizor', 40139403: 'Oris',
    40161837: 'Matar', 40161840: 'Vakir', 40161845: 'Kulheim', 40240009: 'Intaki Prime',
    40314573: 'Caldari Prime', 40329081: 'Kjarval',
}
_ROMAN = [(1000, 'M'), (900, 'CM'), (500, 'D'), (400, 'CD'), (100, 'C'), (90, 'XC'),
          (50, 'L'), (40, 'XL'), (10, 'X'), (9, 'IX'), (5, 'V'), (4, 'IV'), (1, 'I')]
def roman(n):
    r = ''
    for v, sym in _ROMAN:
        while n >= v:
            r += sym
            n -= v
    return r
planets = {p['_key']: p for p in jrows('mapPlanets.jsonl')}
moons = {m['_key']: m for m in jrows('mapMoons.jsonl')}

# Planeten per systeem, voor de PI-opzetplanner: per planeet [romeins nummer,
# planeettype, straal in km]. Het hele universum en niet één regio — een corp
# verhuist, en dan wil je niet dat hier een bundel voor herbouwd moet worden.
#
# De straal doet ertoe: in PI kost een link CPU naar rato van z'n lengte, en die
# schaalt mee met de planeet. Een gasreus van 27.000 km is veertien keer zo
# groot als een barren van 1.900 km, dus dezelfde opstelling kost daar een
# veelvoud. Voor een fabrieksplaneet (launchpad + vijf fabrieken, dus veel
# links) wil je juist de kleinste planeet die je kunt krijgen.
#
# Let op: welke grondstof er op een planeet zit staat hier NIET in, en ook
# nergens anders in de SDE of in ESI. Dat is een spelregel per planeettype, en
# de rijkheid zie je alleen in de client.
out_planets = {}
for p in planets.values():
    out_planets.setdefault(str(p['solarSystemID']), []).append(
        [p['celestialIndex'], p['typeID'], round(p['radius'] / 1000)])
for rij in out_planets.values():
    rij.sort()
write('planets.json', out_planets)
corps = {c['_key']: en(c['name']) for c in jrows('npcCorporations.jsonl')}
ops = {o['_key']: en(o.get('operationName')) for o in jrows('stationOperations.jsonl')}
def celestial(st):
    o = st['orbitID']
    if o in moons:   # maan-station: altijd Arabisch, zonder eigennaam ("Luminaire 7 - Moon 4")
        m = moons[o]
        p = planets[m['orbitID']]
        return f"{sysname[p['solarSystemID']]} {p['celestialIndex']} - Moon {m['orbitIndex']}"
    if o in planets:  # planeet-station: benoemd → Romeins + eigennaam, anders Arabisch
        p = planets[o]
        sn = sysname[p['solarSystemID']]
        idx = p['celestialIndex']
        return f"{sn} {roman(idx)} ({NAMED_PLANETS[o]})" if o in NAMED_PLANETS else f"{sn} {idx}"
    return sysname[st['solarSystemID']]   # zonder planeet/maan (bv. Zarzakh) → systeemnaam
out_sta = {}
for st in jrows('npcStations.jsonl'):
    c = celestial(st)
    corp = corps.get(st['ownerID'], '')
    op = ops.get(st['operationID'], '')
    nm = f"{c} - {corp} {op}".strip() if st.get('useOperationName') else f"{c} - {corp}".strip()
    out_sta[str(st['_key'])] = [nm, st['solarSystemID']]
write('stations.json', out_sta)

# Type-info: { typeId: [groupId, volume, portionSize] }  — SP-per-categorie, m³, reprocessing-batch
out_ti = {str(t['_key']): [t['groupID'], t.get('volume', 0), t['portionSize']]
          for t in jrows('types.jsonl')}
write('type-info.json', out_ti)

# Boosters (combat-drugs): groep 303-producten die een manufacturing-recept hebben.
booster_ids = sorted({ bp['p'][0] for bp in out_bp.values()
                       if str(bp['p'][0]) in out_ti and out_ti[str(bp['p'][0])][0] == 303 })
write('boosters.json', booster_ids)

# Groepen: { groupId: [naam, categoryId] }
out_grp = {str(g['_key']): [en(g['name']), g['categoryID']] for g in jrows('groups.jsonl')}
write('groups.json', out_grp)

# Schepen (categorie 6) → { naam-lowercase: typeId } voor intel-schipherkenning.
ship_groups = {int(gid) for gid, gv in out_grp.items() if gv[1] == 6}
out_ships = {}
for tid, name in out_names.items():
    ti = out_ti.get(str(tid))
    if ti and ti[0] in ship_groups:
        k = name.lower()
        if k not in out_ships:
            out_ships[k] = int(tid)
write('ships.json', out_ships)

# Categorieën: { categoryId: naam }
write('categories.json', {str(c['_key']): en(c['name']) for c in jrows('categories.jsonl')})

# Reprocessing-opbrengst: { typeId: [[materiaalId, aantal], ...] }
out_rep = {}
for t in jrows('typeMaterials.jsonl'):
    mats = t.get('materials') or []
    if mats:
        out_rep[str(t['_key'])] = [[m['materialTypeID'], m['quantity']] for m in mats]
write('reprocess.json', out_rep)

zf.close()

# SDE-versie (officiële build) — voor weergave + update-detectie
ver = json.loads(urllib.request.urlopen(LATEST, timeout=30).read().decode().splitlines()[0])
versiepad = os.path.join(PUB, 'sde-version.json')

# `generatedAt` alleen verzetten als CCP echt een nieuwe SDE heeft uitgebracht.
#
# Waarom dit ertoe doet: de workflow kijkt met `git status public/` of er iets
# veranderd is. Zetten we hier elke keer de klok van nu neer, dan ziet git altijd
# een wijziging — ook als de SDE al weken dezelfde is. Gevolg was een commit,
# een volledige build én een FTP-upload van de hele site, elke dag opnieuw, voor
# één tijdstempel. Zelfde SDE erin hoort zelfde bestanden eruit te geven.
vorige = {}
try:
    with open(versiepad, encoding='utf-8') as f:
        vorige = json.load(f)
except (OSError, ValueError):
    pass

zelfde = (vorige.get('build') == ver.get('buildNumber')
          and vorige.get('releaseDate') == ver.get('releaseDate'))
version = {
    'build': ver.get('buildNumber'),
    'releaseDate': ver.get('releaseDate'),
    'generatedAt': (vorige.get('generatedAt') if zelfde and vorige.get('generatedAt')
                    else datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')),
}
with open(versiepad, 'w', encoding='utf-8') as f:
    json.dump(version, f, ensure_ascii=False)
print(f'  sde-version.json: build #{version["build"]} ({version["releaseDate"]})'
      + ('  — ongewijzigd, tijdstempel blijft staan' if zelfde else '  — NIEUW'))

print('Klaar.')
