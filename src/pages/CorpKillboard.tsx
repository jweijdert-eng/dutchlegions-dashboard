import { KillboardView } from './Kills'

// Losse, op zichzelf staande Corp Killboard — zelfde body als de persoonlijke
// killboard maar vast op corp-scope, zonder Mijn/Corp-toggle.
export default function CorpKillboard() {
  return <KillboardView scope="corp" />
}
