#!/bin/sh
set -eu
export HOME=/tmp/trivia-browser-home
export NODE_EXTRA_CA_CERTS=/app/.certs/ca.pem
mkdir -p "$HOME/.pki/nssdb"
certutil -N --empty-password -d "sql:$HOME/.pki/nssdb"
certutil -A -d "sql:$HOME/.pki/nssdb" -n 'Trivia development CA' -t 'C,,' -i .certs/ca.pem
# Test-only leaf for a genuinely cross-site IP Origin. No production certificate changes.
openssl req -newkey rsa:2048 -nodes -keyout "$HOME/foreign-key.pem" \
  -out "$HOME/foreign.csr" -subj '/CN=Trivia Origin probe' 2>/dev/null
printf '%s\n' 'subjectAltName=DNS:localhost,IP:127.0.0.1' 'extendedKeyUsage=serverAuth' \
  'basicConstraints=critical,CA:FALSE' > "$HOME/foreign.ext"
openssl x509 -req -in "$HOME/foreign.csr" -CA .certs/ca.pem -CAkey .certs/ca-key.pem \
  -set_serial 7341 -out "$HOME/foreign.pem" -days 1 -sha256 -extfile "$HOME/foreign.ext" 2>/dev/null
export SMOKE_FOREIGN_KEY="$HOME/foreign-key.pem"
export SMOKE_FOREIGN_CERT="$HOME/foreign.pem"
exec node scripts/browser-smoke.mjs
