#!/bin/bash
# Vernieuwt ftps-ca.pem naast dit script.
#
# De FTP-server van de host (h63.mijn.host) stuurt zijn Let's Encrypt-certificaat zonder
# tussencertificaat mee. Node kan de keten dan niet afmaken en weigert de verbinding.
# Deze bundel bevat de publieke tussencertificaten van Let's Encrypt, en alleen de
# certificaten die aantoonbaar aan een ISRG-root hangen die Node al vertrouwt.
# Draai dit opnieuw als de upload faalt met "unable to verify the first certificate".
set -e
doel="$(cd "$(dirname "$0")" && pwd)/ftps-ca.pem"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
node -e "require('fs').writeFileSync('node-roots.pem', require('tls').rootCertificates.join('\n'))"

haal() {
  curl -s -m 20 -o "$1.der" "http://$1.i.lencr.org/" || return 1
  openssl x509 -inform der -in "$1.der" -out "$1.pem" 2>/dev/null || return 1
}

: > kruis.pem
for r in ye yr; do
  if haal "$r" && openssl verify -CAfile node-roots.pem "$r.pem" >/dev/null 2>&1; then
    cat "$r.pem" >> kruis.pem
  fi
done

: > bundel.pem
cat kruis.pem >> bundel.pem
for i in ye1 ye2 ye3 yr1 yr2 yr3 e5 e6 e7 e8 e9 r10 r11 r12 r13 r14; do
  if haal "$i" && openssl verify -CAfile node-roots.pem -untrusted kruis.pem "$i.pem" >/dev/null 2>&1; then
    cat "$i.pem" >> bundel.pem
  fi
done

mv bundel.pem "$doel"
echo "Geschreven: $doel ($(grep -c 'BEGIN CERT' "$doel") certificaten)"
