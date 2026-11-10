#!/bin/sh
set -eu
umask 077
mkdir -p .certs
if [ -e .certs/localhost.pem ] || [ -e .certs/localhost-key.pem ]; then
  echo 'Server certificate/key already exists; refusing to overwrite local trust material.'
  exit 1
fi
if [ ! -e .certs/ca.pem ] && [ ! -e .certs/ca-key.pem ]; then
openssl req -x509 -newkey rsa:3072 -nodes -days 365 -sha256 \
  -keyout .certs/ca-key.pem -out .certs/ca.pem -subj '/CN=Trivia local development CA' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign'
elif [ ! -e .certs/ca.pem ] || [ ! -e .certs/ca-key.pem ]; then
  echo 'Incomplete CA material; restore it or explicitly create a new local CA.'
  exit 1
fi
openssl req -newkey rsa:2048 -nodes -keyout .certs/localhost-key.pem \
  -out .certs/localhost.csr -subj '/CN=localhost'
cat > .certs/localhost.ext <<'EOF'
subjectAltName=DNS:localhost
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
EOF
openssl x509 -req -in .certs/localhost.csr -CA .certs/ca.pem -CAkey .certs/ca-key.pem \
  -CAcreateserial -out .certs/localhost.pem -days 90 -sha256 -extfile .certs/localhost.ext
echo 'Trust .certs/ca.pem in your browser/OS. Keep private keys local.'
