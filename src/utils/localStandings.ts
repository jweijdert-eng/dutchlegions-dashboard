const KEY = 'eve_local_standings'

export type Standing = 'friend' | 'enemy'

export function getStandings(): Record<string, Standing> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') }
  catch { return {} }
}

export function setStanding(name: string, standing: Standing | null) {
  const s = getStandings()
  if (standing === null) delete s[name]
  else s[name] = standing
  localStorage.setItem(KEY, JSON.stringify(s))
}
