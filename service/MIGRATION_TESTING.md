# Embedding Migration Testing

How to verify the version-gated embedding migration in `memory-search.js`.
Run these after any change to `EMBED_DIM` or `EMBED_MODEL` in `embeddings.js`.

## What the migration does

`migrateEmbeddingTable()` runs once per DB handle on first `ensureInitialized()` call.
It stores `embedding_dim` and `embedding_model` in the `settings` table as a version stamp.

- **No stamp + table missing** → create table, write stamp, trigger backfill
- **No stamp + table exists, correct dim** → write stamp, no backfill
- **No stamp + table exists, wrong dim** → log row count, drop, recreate, write stamp, trigger backfill
- **Stamp matches current config** → nothing (fast path, most boots)
- **Stamp differs** → log, drop, recreate, update stamp, trigger backfill

## Test sequence

### Boot 1 — detect mismatch, rebuild (the current production case)

Start server cold. Carrier log should show:

```
[PAN MemorySearch] migration: dimension mismatch on first-tracked boot — dropping N stale rows (incompatible with qwen3-embedding@1024)
[PAN MemorySearch] backfill starting: 0/TOTAL indexed, TOTAL to embed
[PAN MemorySearch] backfill: +200/TOTAL (200/TOTAL total)   ← every 200 events
...
[PAN MemorySearch] backfill complete: +N embeddings (N/TOTAL total)
```

Verify settings table after boot:
```sql
SELECT key, value FROM settings WHERE key IN ('embedding_dim', 'embedding_model');
-- embedding_dim   | 1024
-- embedding_model | qwen3-embedding
```

### Boot 2 — no migration runs

Restart server. Log should be silent — no migration lines at all.
The fast path (`storedDim.value === currentDim && storedModel.value === currentModel`) returns false immediately.

### Boot 3 — simulate model change (dim flip down)

In `service/src/memory/embeddings.js`, temporarily change:
```js
const EMBED_DIM = 768;   // was 1024
const EMBED_MODEL = 'test-model-768';
```

Restart. Log should show:
```
[PAN MemorySearch] migration: embedding config changed — qwen3-embedding@1024 → test-model-768@768. Dropping N rows and rebuilding.
[PAN MemorySearch] backfill starting: ...
```

Settings table after:
```sql
-- embedding_dim   | 768
-- embedding_model | test-model-768
```

### Boot 4 — simulate model change (dim flip back)

Revert `embeddings.js` to `EMBED_DIM = 1024` / `EMBED_MODEL = 'qwen3-embedding'`.
Restart. Same pattern as Boot 3 but in reverse. Confirms the migration fires on every
config change, not just on initial setup.

## Failure modes to watch for

| Symptom | Likely cause |
|---|---|
| `[PAN MemorySearch] vec query failed: Dimension mismatch` on every search | Migration didn't run or ran against a different DB handle than the query |
| Migration runs on every boot | Settings writes failing (check DB write permissions) |
| Backfill never completes | Ollama down — fallback keyword embeddings will be used instead, backfill will finish but with lower quality vectors |
| `backfill embed failed for event N` warnings in bulk | Individual event has unparseable data — normal, skipped silently |
