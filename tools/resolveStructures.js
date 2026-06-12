const fs = require('fs')
const fetch = globalThis.fetch || require('node-fetch')

async function resolveStructure(id, token) {
  const url = `https://esi.evetech.net/latest/universe/structures/${id}/`
  const headers = token ? { Authorization: `Bearer ${token}` } : {}
  try {
    const res = await fetch(url, { headers })
    if (res.status === 200) return { ok: true, data: await res.json() }
    return { ok: false, status: res.status }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

async function tryNames(ids) {
  const url = 'https://esi.evetech.net/latest/universe/names/'
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ids) })
    if (res.status === 200) return await res.json()
  } catch (err) {
    return null
  }
}

async function main() {
  const idsArg = process.argv[2]
  if (!idsArg) {
    console.error('Usage: node tools/resolveStructures.js "id1,id2,..." OR "chars:charId1,charId2"')
    process.exit(1)
  }

  const tokensEnv = process.env.ESI_TOKENS || ''
  const tokens = tokensEnv.split(',').map(s => s.trim()).filter(Boolean)
  const charIdsEnv = process.env.ESI_CHAR_IDS || ''
  const envCharIds = charIdsEnv.split(',').map(s => s.trim()).filter(Boolean)

  let targetStructureIds = []

  if (idsArg.startsWith('chars:')) {
    const charIds = idsArg.slice('chars:'.length).split(',').map(s => s.trim()).filter(Boolean)
    if (charIds.length === 0) {
      console.error('No character IDs provided after chars:')
      process.exit(1)
    }

    // map each charId to a token: prefer envCharIds mapping, else map by index if counts match
    const charTokenMap = {}
    for (let i = 0; i < charIds.length; i++) {
      const cid = charIds[i]
      let token = null
      if (envCharIds.length && tokens.length) {
        const idx = envCharIds.indexOf(cid)
        if (idx !== -1 && tokens[idx]) token = tokens[idx]
      }
      if (!token && tokens.length === charIds.length) token = tokens[i]
      if (!token) {
        console.error(`Missing token for character ${cid}. Provide ESI_TOKENS and optionally ESI_CHAR_IDS mapping.`)
        process.exit(2)
      }
      charTokenMap[cid] = token
    }

    // fetch asset locations for each character and collect structure IDs
    const structureSet = new Set()
    for (const cid of Object.keys(charTokenMap)) {
      const token = charTokenMap[cid]
      const url = `https://esi.evetech.net/latest/characters/${cid}/assets/locations/`
      try {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        if (res.status !== 200) {
          console.error(`Failed to fetch assets/locations for ${cid}: ${res.status}`)
          continue
        }
        const body = await res.json()
        // body can be object mapping item_id -> location_id or array
        if (Array.isArray(body)) {
          for (const e of body) {
            const lid = e.location_id ?? null
            const ltype = e.location_type ?? null
            if (ltype === 'structure' || (typeof lid === 'number' && lid > 2_147_483_647)) structureSet.add(String(lid))
          }
        } else if (body && typeof body === 'object') {
          for (const v of Object.values(body)) {
            const lid = (v && v.location_id) || v
            if (typeof lid === 'number' && lid > 2_147_483_647) structureSet.add(String(lid))
          }
        }
      } catch (err) {
        console.error(`Error fetching assets/locations for ${cid}: ${String(err)}`)
      }
    }

    targetStructureIds = Array.from(structureSet)
    if (targetStructureIds.length === 0) console.log('No structure IDs found in assets/locations for provided characters.')
  } else {
    targetStructureIds = idsArg.split(',').map(s => s.trim()).filter(Boolean)
  }

  const out = {}
  for (const id of targetStructureIds) {
    out[id] = { tries: [], namesFallback: null }
    // try authenticated tokens first (if any)
    for (const t of tokens.length ? tokens : [null]) {
      const r = await resolveStructure(id, t)
      out[id].tries.push({ tokenProvided: !!t, result: r.ok ? { id: r.data.structure_id, name: r.data.name, solar_system_id: r.data.solar_system_id, type_id: r.data.type_id } : { status: r.status || null, error: r.error || null } })
      if (r.ok) break
    }
  }

  // try universe/names fallback for any that still have no positive result (works for int32 ids)
  const unresolved = Object.keys(out).filter(id => !out[id].tries.some(x => x.result && x.result.name))
  if (unresolved.length) {
    const names = await tryNames(unresolved.map(id => parseInt(id, 10)))
    if (names && names.length) {
      for (const n of names) {
        const id = String(n.id)
        out[id].namesFallback = n
      }
    }
  }

  fs.writeFileSync('tools/structure_results.json', JSON.stringify(out, null, 2))
  console.log('Results written to tools/structure_results.json')
}

main().catch(err => { console.error(err); process.exit(2) })
