# Retired demo evidence

The standalone demo/durable-harness prototype was retired after the formal backend and copied React UI proved its public behaviours: SQLite transcript restart, request admission dedup, client closure without run ownership, reconnect snapshot and streaming state. Additional production-path manual checks cover live tools and SIGKILL recovery without unsafe replay.

This whole directory is **historical evidence**. Its files are preserved verbatim with bash cp; the commands, paths
and commit references inside them are historical, not current instructions, and the SHA256 manifest records the retired
source identity at the time of removal. Nothing here is re-run.
Current entrypoints: [../verification.md](../verification.md) for what to run, [../../README.md](../../README.md) for
startup, and [../local-integration.md](../local-integration.md) for gateway trust and lifecycle.
Historical README content follows. The SHA256 manifest records retired source identity. This was local prototype code using published MIT pi-durable/pi-ai/chord@1.1.0 packages, not vendored upstream runtime. Retiring it removes an unauthenticated duplicate entrypoint and its npm dependency tree; use root pnpm workspace now.

The cleanup does not depend on real paid-provider inference because the old prototype also only used faux. Paid-provider and whole upstream desktop parity remain separate verification gates. Current startup is in root README.md and docs/local-integration.md.
