// Schrijft na `vite build` het databasewachtwoord in dist/api/config.geheim.php.
//
// De repo is openbaar, dus het wachtwoord mag er niet in staan. GitHub Actions
// geeft het mee als geheim (DB_PASS); dit script zet het in een PHP-bestand dat
// alleen op de server bestaat. Ontbreekt het geheim, dan stopt de deploy: liever
// geen nieuwe versie dan een site die niet bij zijn database kan.
import fs from 'node:fs'

// Bij plakken in GitHub gaat er makkelijk een spatie of enter mee; die horen
// niet bij het wachtwoord en laten de database de login weigeren.
const ruw = process.env.DB_PASS || ''
const wachtwoord = ruw.trim()
if (ruw !== wachtwoord) console.log('Let op: spaties/enters rond het geheim DB_PASS weggehaald')
if (!wachtwoord) {
  console.error('DB_PASS ontbreekt: zet het als geheim in GitHub (Settings > Secrets and variables > Actions).')
  process.exit(1)
}
// PHP-string tussen enkele aanhalingstekens: alleen \ en ' hoeven ge-escaped.
const veilig = wachtwoord.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
fs.mkdirSync('dist/api', { recursive: true })
fs.writeFileSync('dist/api/config.geheim.php', `<?php\ndefine('DB_PASS', '${veilig}');\n`)
console.log('config.geheim.php geschreven (' + wachtwoord.length + ' tekens)')
