export type EventType = 'damage' | 'shield' | 'armor' | 'hull' | 'cap' | 'neut' | 'nos' | 'mining'
export type Direction = 'out' | 'in'

export interface CombatEvent {
  timestamp: number
  type: EventType
  dir: Direction
  amount: number
  oreType?: string
}

// Patterns derived from PyEveLiveDPS logreader.py — specific patterns first, damage last
const COMBAT_PATTERNS: Array<{ re: RegExp; type: EventType; dir: Direction }> = [
  { re: /\(combat\) <.*?><b>([0-9]+).*> remote shield boosted to </, type: 'shield', dir: 'out' },
  { re: /\(combat\) <.*?><b>([0-9]+).*> remote shield boosted by </, type: 'shield', dir: 'in' },
  { re: /\(combat\) <.*?><b>([0-9]+).*> remote armor repaired to </, type: 'armor', dir: 'out' },
  { re: /\(combat\) <.*?><b>([0-9]+).*> remote armor repaired by </, type: 'armor', dir: 'in' },
  { re: /\(combat\) <.*?><b>([0-9]+).*> remote hull repaired to </, type: 'hull', dir: 'out' },
  { re: /\(combat\) <.*?><b>([0-9]+).*> remote hull repaired by </, type: 'hull', dir: 'in' },
  { re: /\(combat\) <.*?><b>([0-9]+).*> remote capacitor transmitted to </, type: 'cap', dir: 'out' },
  { re: /\(combat\) <.*?><b>([0-9]+).*> remote capacitor transmitted by </, type: 'cap', dir: 'in' },
  // Neut: color ff7fffff = you neut enemy, ffe57f7f = enemy neuts you
  { re: /\(combat\) <.*?ff7fffff><b>([0-9]+).*> energy neutralized </, type: 'neut', dir: 'out' },
  { re: /\(combat\) <.*?ffe57f7f><b>([0-9]+).*> energy neutralized </, type: 'neut', dir: 'in' },
  // NOS: +amount = you drain from enemy (out), -amount = enemy drains from you (in)
  { re: /\(combat\) <.*?><b>\+([0-9]+).*> energy drained from </, type: 'nos', dir: 'out' },
  { re: /\(combat\) <.*?><b>-([0-9]+).*> energy drained to </, type: 'nos', dir: 'in' },
  // Damage: >to< / >from< are the bolded direction words <b>to</b> / <b>from</b>
  { re: /\(combat\) <.*?><b>([0-9]+).*>to</, type: 'damage', dir: 'out' },
  { re: /\(combat\) <.*?><b>([0-9]+).*>from</, type: 'damage', dir: 'in' },
]

const MINING_RE = /\(mining\) .*?<.*?><.*?>([0-9]+).*?> units of <.*?><.*?>(.+?)</
const TS_RE = /^\[ (\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}) \]/

function parseTs(s: string): number {
  const [date, time] = s.split(' ')
  const [y, mo, d] = date.split('.').map(Number)
  const [h, mi, se] = time.split(':').map(Number)
  return Date.UTC(y, mo - 1, d, h, mi, se)
}

export function parseCombatLog(text: string): CombatEvent[] {
  const events: CombatEvent[] = []

  for (const line of text.split('\n')) {
    const tsMatch = TS_RE.exec(line)
    if (!tsMatch) continue
    const timestamp = parseTs(tsMatch[1])

    const miningMatch = MINING_RE.exec(line)
    if (miningMatch) {
      events.push({ timestamp, type: 'mining', dir: 'out', amount: parseInt(miningMatch[1], 10), oreType: miningMatch[2]?.trim() })
      continue
    }

    for (const { re, type, dir } of COMBAT_PATTERNS) {
      const m = re.exec(line)
      if (m) {
        const amount = parseInt(m[1], 10)
        if (amount > 0) events.push({ timestamp, type, dir, amount })
        break
      }
    }
  }

  return events
}

export interface BucketRow {
  time: string
  dpsOut: number; dpsIn: number
  shieldOut: number; shieldIn: number
  armorOut: number; armorIn: number
  hullOut: number; hullIn: number
  capOut: number; capIn: number
  neutOut: number; neutIn: number
  nosOut: number; nosIn: number
  mined: number
}

export function bucketEvents(
  events: CombatEvent[],
  windowSecs: number | null,
  bucketSecs: number,
): BucketRow[] {
  if (events.length === 0) return []

  let maxTs = 0
  for (const e of events) if (e.timestamp > maxTs) maxTs = e.timestamp
  const cutoff = windowSecs ? maxTs - windowSecs * 1000 : 0
  const filtered = events.filter(e => e.timestamp >= cutoff)
  if (filtered.length === 0) return []

  const bms = bucketSecs * 1000
  const minB = Math.floor(filtered[0].timestamp / bms) * bms
  const maxB = Math.floor(filtered[filtered.length - 1].timestamp / bms) * bms

  const map = new Map<number, BucketRow>()
  for (let t = minB; t <= maxB; t += bms) {
    const d = new Date(t)
    map.set(t, {
      time: `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}:${d.getUTCSeconds().toString().padStart(2, '0')}`,
      dpsOut: 0, dpsIn: 0,
      shieldOut: 0, shieldIn: 0,
      armorOut: 0, armorIn: 0,
      hullOut: 0, hullIn: 0,
      capOut: 0, capIn: 0,
      neutOut: 0, neutIn: 0,
      nosOut: 0, nosIn: 0,
      mined: 0,
    })
  }

  for (const e of filtered) {
    const b = map.get(Math.floor(e.timestamp / bms) * bms)
    if (!b) continue
    switch (e.type) {
      case 'damage':
        if (e.dir === 'out') b.dpsOut += e.amount / bucketSecs
        else b.dpsIn += e.amount / bucketSecs
        break
      case 'shield':
        if (e.dir === 'out') b.shieldOut += e.amount; else b.shieldIn += e.amount
        break
      case 'armor':
        if (e.dir === 'out') b.armorOut += e.amount; else b.armorIn += e.amount
        break
      case 'hull':
        if (e.dir === 'out') b.hullOut += e.amount; else b.hullIn += e.amount
        break
      case 'cap':
        if (e.dir === 'out') b.capOut += e.amount; else b.capIn += e.amount
        break
      case 'neut':
        if (e.dir === 'out') b.neutOut += e.amount; else b.neutIn += e.amount
        break
      case 'nos':
        if (e.dir === 'out') b.nosOut += e.amount; else b.nosIn += e.amount
        break
      case 'mining':
        b.mined += e.amount
        break
    }
  }

  return Array.from(map.entries()).sort((a, b) => a[0] - b[0]).map(([, row]) => row)
}
