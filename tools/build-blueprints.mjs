// Genereert public/blueprints.json uit de EVE SDE (alleen manufacturing),
// gekeyed op blueprint-typeID. Compact formaat: { bpId: { m:[[matId,qty],...], p:[prodId,qty] } }
import { writeFileSync } from 'fs'
const SRC = 'https://sde.hoboleaks.space/tq/blueprints.json'
console.log('Downloaden SDE blueprints…')
const sde = await (await fetch(SRC)).json()
const out = {}
let n = 0
for (const [bpId, bp] of Object.entries(sde)) {
  const mfg = bp?.activities?.manufacturing
  if (!mfg) continue
  const prod = (mfg.products ?? [])[0]
  if (!prod) continue
  out[bpId] = {
    m: (mfg.materials ?? []).map(x => [x.typeID, x.quantity]),
    p: [prod.typeID, prod.quantity],
  }
  n++
}
writeFileSync('public/blueprints.json', JSON.stringify(out))
console.log(`${n} manufacturing-blueprints → public/blueprints.json`)
