# Security policy

## Supported line

The supported development line is `0.2.x secure-v2`. Security fixes are expected to land on the newest release candidate before a public beta is promoted.

## Reporting a vulnerability

Please use the repository's private security-advisory/reporting mechanism when one is available. Do not publish exploit details, private keys, wallet secrets, or proof-of-concept attacks against the live pool before maintainers have had a chance to investigate.

Useful reports include the affected version, platform, minimal reproduction steps, expected/observed behavior, and whether the issue can change payouts, consensus, block submission, native binary integrity, or resource consumption.

## Security boundaries

The CLI never needs a BYZE wallet seed, private key, or passphrase. Its P2P identity is ephemeral. Native mining components are accepted only from the managed native directory, with SHA-256 verification and an upstream source-commit pin. The public pool is mainnet-only and fails closed when the local BYZE node is not synchronized.

## Release signing key

Official BYZE P2Pool CLI release manifests are signed with the dedicated
Ed25519 release key stored outside this repository.

The corresponding public verification key is:

`keys/release-ed25519.pub.pem`

Always verify a release manifest and the artifact SHA-256 before running
downloaded release binaries.
