'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '../..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

test('public guided installer advertises RC2 only and keeps executable commands disabled', () => {
  const html = read('docs/index.html')
  const release = 'v0.3.0-rc2.dev'
  for (const platform of ['darwin-arm64', 'darwin-x64', 'linux-x64']) {
    assert.ok(html.includes("'" + platform + "':{tag:'" + release + "',archive:'byze-p2pool-cli-complete-0.3.0-rc2.dev-" + platform + ".tar.gz'}"),
      'Site release metadata must point to RC2 for ' + platform)
  }
  assert.doesNotMatch(html, /v0\.2\.5-rc4-community\.2/, 'Historical release must not appear in new install instructions')
  assert.match(html, /const FORK_P2POOL_INSTALLER_PAUSED = true;/)
  assert.match(html, /installCode\.textContent=FORK_P2POOL_INSTALLER_PAUSED\?t\('installPausedCommand'\)/)
  assert.match(html, /code\.textContent=FORK_P2POOL_INSTALLER_PAUSED\?t\('miningPausedCommand'\)/)
  assert.match(html, /installCopy\.disabled=!available/)
  assert.match(html, /copy\.disabled=FORK_P2POOL_INSTALLER_PAUSED\|\|!valid/)
  assert.match(html, /v0\.3\.0-rc2\.dev · diagnostic only/)
})

test('Linux and macOS installers reject guided P2Pool installation before downloading legacy CLI', () => {
  for (const file of ['docs/install-linux.sh', 'docs/install-macos.sh']) {
    const script = read(file)
    assert.match(script, /guided installer paused: RC2 experimental archives/)
    assert.match(script, /multi-peer PPLNS payouts are not validated/i)
    assert.match(script, /fail (?:'|")P2Pool guided installer paused:/,
      file + ' must keep --install failing closed')
    // Legacy values are retained for historical diagnostics; guided installation is not permitted.
    assert.match(script, /v0\.2\.5-rc4-community\.2/)
  }
})
