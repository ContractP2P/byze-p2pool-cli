#!/bin/sh
set -e
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$HERE"
printf '%s\n' 'Installation développeur BYZE P2Pool CLI v0.2.5-rc1…'
npm ci
npm run check
npm test
npm run native:bootstrap-official
node tools/ensure-native.js
printf '%s\n' '' 'Bundle développeur construit depuis le commit upstream épinglé. Lancez ./byze-p2pool --dry-run avant de miner.'
