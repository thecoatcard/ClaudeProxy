# WORKSPACE FINGERPRINT REPORT

## Phase 2 — Workspace Fingerprinting

**Module**: `lib/session/workspace-fingerprint.ts`  
**Tests**: `tests/workspace-fingerprint.test.ts` — 28 tests passing

---

## Architecture

### Extraction Priority Chain

The fingerprint system extracts the workspace root from up to 6 sources in priority order:

1. `<workspacePath>tag</workspacePath>` in system text (Claude Code primary format)
2. `<cwd>tag</cwd>` in system text
3. `Cwd: /path` header in system text
4. `Current Working Directory (/path)` in system text
5. `workspace_root: /path` pattern in system text
6. Scan of first 4 user messages for any of the above patterns

### Normalisation

All paths are normalised before hashing:
- Backslashes → forward slashes
- Trailing slashes removed
- Entire path lowercased (Windows case-insensitive)

This ensures `C:\Users\Dev\Project` and `c:/users/dev/project` produce the same fingerprint.

### Confidence Levels

| Confidence | Condition | Fingerprint Reliability |
|---|---|---|
| `high` | Explicit cwd/workspacePath found | Reliable workspace isolation |
| `low` | Partial path hint detected | May not uniquely identify workspace |
| `none` | No workspace signal found | Returns `00000000` fallback |

### Fallback Fingerprint (`00000000`)

When no workspace can be detected, the fallback fingerprint `00000000` is used. The session binding validator treats `00000000` as a wildcard — it won't cause a mismatch against any real fingerprint. This ensures graceful degradation when Claude Code doesn't inject workspace context.

---

## Integration

The fingerprint is computed in `transformRequestToGemini()` before conversationId finalization:

```typescript
const workspaceFp = computeWorkspaceFingerprint(rawSystemForExtraction, messages);
// Used in: finalizeConversationId(), saveSessionBinding(), hydration logging
```

It flows through:
1. **Session identity** (Phase 1): `hash(userId | fingerprint | nonce)` 
2. **Session binding** (Phase 4): stored and validated on every request
3. **Logging**: `workspaceFingerprint` and `workspaceConfidence` in hydration verdict log

---

## Test Coverage

| Scenario | Result |
|---|---|
| `<workspacePath>` tag extraction | Pass |
| `<cwd>` tag extraction | Pass |
| `Cwd:` header extraction | Pass |
| `Current Working Directory (...)` extraction | Pass |
| Message scan (first 4) | Pass |
| Beyond-4-message cutoff | Pass (null) |
| Path normalisation (Windows backslash) | Pass |
| Same fingerprint for same workspace | Pass |
| Different fingerprints for different workspaces | Pass |
| None-confidence fallback when no path | Pass |
| Fingerprint comparison: match/mismatch/unknown | Pass |
| Fallback fingerprint treated as wildcard | Pass |
