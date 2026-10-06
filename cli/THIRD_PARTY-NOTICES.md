# Third-party notices

JavaScript dependency versions are recorded in `package-lock.json`; retain their individual license files when packaging `node_modules`.

## Native miner and RandomX

The managed binaries identify upstream source commit `d84db8a84ba4a06432fcdddbf1584b89a7e52379` of `powhermes/byze-miner`.

Upstream commit `ab5ab096e26ca4af93631350ef7f68129500b899` adds an MIT license for its own source and a third-party notice for RandomX. A complete Git tree comparison with the pinned source shows only those two added documentation files; the source and build files are identical. The native source pin and binary hashes are retained for reproducibility.

- byze-miner own source: [MIT notice](licenses/byze-miner-MIT.txt).
- Vendored RandomX: [BSD 3-Clause notice](licenses/RandomX-BSD-3-Clause.txt).
- Upstream provenance: https://github.com/powhermes/byze-miner/commit/ab5ab096e26ca4af93631350ef7f68129500b899

Include this file and both license texts with every distribution containing the native components, including standalone native bundles. Existing platform bundles remain subject to the release checklist; this source candidate is not a signed end-user release. The CLI itself remains `UNLICENSED` pending its owner's license choice.
