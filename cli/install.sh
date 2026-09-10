#!/bin/sh
set -e
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$HERE"
printf '%s\n' 'Installation BYZE P2Pool CLI v0.2.5-rc1…'
npm ci
npm run check
npm test
if node tools/ensure-native.js; then
  printf '%s\n' '' 'Installation terminée. Vous pouvez lancer ./byze-p2pool.'
else
  printf '%s\n' '' 'Le code JS est valide, mais ce paquet RC source ne contient pas encore le bundle natif signé/précompilé de votre plateforme.'
  printf '%s\n' 'Pour un test développeur uniquement : npm run native:bootstrap-official'
  exit 4
fi
