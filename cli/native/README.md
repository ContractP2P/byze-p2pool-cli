# Managed native components

Public releases should contain a platform directory such as:

```text
native/darwin-arm64/
native/darwin-x64/
native/linux-x64/
native/win32-x64/
```

with `byze-p2pool-miner`, `byze-rxhash`, and `native-manifest.json`.

The runtime verifies the executable SHA-256, rejects symlinks/path escapes, and requires `sourceCommit` to equal the pinned upstream commit `d84db8a84ba4a06432fcdddbf1584b89a7e52379`.

This v0.2.5-rc1 source archive intentionally does not redistribute derived native binaries. Use `npm run native:bootstrap-official` only for a local developer build from the pinned official source.
