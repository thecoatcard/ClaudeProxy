# .coatcard — Project-Scoped Persistent Memory

This directory stores the embedding-based retrieval memory for the gateway.

## Structure

```
.coatcard/
├── embeddings/          # Raw embedding vectors per file
├── summaries/           # Task and error summaries (embedded)
├── task-graph/          # Task dependency graphs
├── artifacts/           # File hashes, incremental state
├── operational-state/   # Operational context snapshots
└── retrieval-index/     # Vector index for similarity search
```

## Persistence

- Survives gateway restart and session restart
- Updated incrementally (only changed files re-embedded)
- File hashes tracked in `artifacts/file-hashes.json`

## Usage

The retrieval pipeline injects top-k relevant context before model calls.
Priority: recent turns > operational memory > task memory > embedding retrieval > compactor summaries
