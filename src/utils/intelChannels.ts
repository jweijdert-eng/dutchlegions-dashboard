// Intel-chatkanalen: beheerd in de Admin (site-config), gedeeld door de Intel-pagina
// en de fleet-kaart. De `prefix` is het begin van de chatlog-bestandsnaam dat EVE
// schrijft (bv. "wc.Dek+Fa+PB" → "wc.Dek+Fa+PB_20260616_….txt"); `label` is alleen
// voor de weergave (tabbladen).
export interface IntelChannel { prefix: string; label: string }

export const DEFAULT_INTEL_CHANNELS: IntelChannel[] = [
  { prefix: 'wc.Dek+Fa+PB',   label: 'Dek / Fa / PB' },
  { prefix: 'wc.Vale+Tr+Ge',  label: 'Vale / Tr / Ge' },
  { prefix: 'wc.Venal+Br+Te', label: 'Venal / Br / Te' },
]
