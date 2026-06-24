# TEST_PLAN.md

Scope: regression tests for the translation gateway. No filesystem/sandbox/exec tests — those are out of scope for this codebase.

## 1. Test stack

- Runtime: Node 20+ (matches Edge polyfill set).
- Framework: `vitest` (fast, ESM-native, easy to drop alongside existing scripts in [package.json](package.json)).
- Suggested layout:
  ```
  tests/
    unit/
      loop-detector.test.ts
      repair.test.ts
      tools.test.ts
      stop-reason.test.ts
      request.test.ts
    integration/
      stream.test.ts          # uses a mocked Gemini SSE feed
      response.test.ts        # uses a canned Gemini JSON response
  ```

If adding `vitest` is unwanted, the same tests can be implemented with the existing `node --test` runner — assertions only differ in import.

## 2. Critical invariants to assert

Across **all** transformer tests:

1. The output object never contains `undefined` values at the top level.
2. No `Buffer`, `process`, `fs`, or `path` calls are reachable.
3. Tool-name sanitization round-trips: `originalToolNames.get(sanitized) === original`.
4. Generated `toolu_*` IDs match `/^toolu_[A-Za-z0-9_-]{24}$/`.

## 3. Loop detector — unit

File: `tests/unit/loop-detector.test.ts`

| # | Setup | Expect |
|---|---|---|
| LD-1 | Empty messages | `detected = false` |
| LD-2 | One failed tool_use+result | `detected = false` (count=1) |
| LD-3 | Two identical failed pairs | `detected = true`, `repeats = 2` |
| LD-4 | Two failed pairs with different `input` | `detected = false` |
| LD-5 | Two failed pairs with key-reordered same input (`{a:1,b:2}` vs `{b:2,a:1}`) | `detected = true` |
| LD-6 | Failed → success → failed (same args) | `detected = false` (streak broken) |
| LD-7 | `is_error: true` with empty content | `detected = true` after 2 |
| LD-8 | Error inferred from text (`ENOENT: no such file`) without `is_error` flag | `detected = true` after 2 |
| LD-9 | Three consecutive identical failures | `repeats = 3` |
| LD-10 | Old loop resolved 5 turns ago, new healthy traffic since | `detected = false` |
| LD-11 | Guidance text contains tool name and last error preview | string contains assertion |

## 4. Repair — unit

File: `tests/unit/repair.test.ts`

| # | Input | Schema | Expect |
|---|---|---|---|
| R-1 | `null` | `{type:'object',properties:{}}` | `{}` |
| R-2 | `'{"x":1}'` (stringified) | `{type:'object',properties:{x:{type:'integer'}}}` | `{x:1}` |
| R-3 | `{x:'7'}` | `{type:'object',properties:{x:{type:'integer'}},required:['x']}` | `{x:7}` |
| R-4 | `{}` missing required | `{required:['x'],properties:{x:{type:'string',default:'hi'}}}` | `{x:'hi'}` |
| R-5 | array root | `{type:'array',items:{type:'string'}}` (top-level repair returns object) | `{items:[...]}` |
| R-6 | nullable schema with `null` value | `{type:['string','null']}` | `null` |
| R-7 | boolean coercion `'yes' / 'no'` | `{type:'boolean'}` | `true` / `false` |
| R-8 | unknown extra props preserved | `{type:'object',properties:{a:{type:'string'}}}` with `{a:'x',extra:42}` | `{a:'x',extra:42}` |

## 5. Tools — unit

File: `tests/unit/tools.test.ts`

| # | Tool input schema | Expect |
|---|---|---|
| T-1 | `oneOf:[{type:'string'},{type:'number'}]` | First branch only, no `oneOf` field. |
| T-2 | `enum:['a','b']` of integer-typed | Type forced to `STRING`, enum stringified. |
| T-3 | Empty `properties: {}` | `parameters` field omitted from declaration. |
| T-4 | Tool name `my-server.tool` | Sanitized to `my_server_tool`; reverse map populated. |
| T-5 | Required field referencing nonexistent property | Stripped from `required`. |
| T-6 | Nested object with `additionalProperties: true` | Field dropped (not in whitelist). |

## 6. Request transform — unit

File: `tests/unit/request.test.ts`

These need a stub for `redis` (`{ get: async()=>null, mget: async(arr)=>arr.map(()=>null), set: async()=>{}, setex: async()=>{} }`) and for `getHealthiestKeyObj`.

| # | Input | Expect |
|---|---|---|
| RQ-1 | `{messages:[{role:'assistant',content:'hi'}]}` | Pre-pended placeholder user turn; assistant→model. |
| RQ-2 | History ending with assistant | Trailing `user: "Continue"` appended. |
| RQ-3 | `thinking:{type:'enabled',budget_tokens:100000}`, `internalModel='gemini-2.5-flash'`, `max_tokens:8192` | `thinkingConfig.thinkingBudget` clamped to `min(24576, 8192-1024)=7168`. |
| RQ-4 | `tool_choice:{type:'tool',name:'my-tool'}` | `toolConfig.functionCallingConfig.allowedFunctionNames=['my_tool']` (sanitized). |
| RQ-5 | History with `tool_use` and matching `tool_result` for which Redis returns no signature | Both demoted to text (`[Action: ...]` / `[Tool Result]:...`). |
| RQ-6 | Loop-detector trigger: 2 identical failed pairs at tail | `result.systemInstruction.parts[0].text` contains `[GATEWAY LOOP DETECTOR]`. |
| RQ-7 | `max_tokens=1000000`, `internalModel='gemini-3-flash-preview'` | `maxOutputTokens = 63488`. |
| RQ-8 | Image part with base64 source | `inlineData.data` round-trips. |
| RQ-9 | Image part with URL source | `fileData.fileUri` round-trips. |
| RQ-10 | `stop_sequences:['<x>','<y>','<z>','<a>','<b>','<c>']` | Truncated to first 5 in `stopSequences`. |

## 7. Response transform — integration

File: `tests/integration/response.test.ts`

| # | Canned Gemini response | Expect |
|---|---|---|
| RS-1 | Single `text` part | One `text` content block, `stop_reason='end_turn'`. |
| RS-2 | `functionCall { name, args }` only | Single `tool_use` block, `stop_reason='tool_use'`, `originalToolNames` reverse-map respected. |
| RS-3 | `text` + `functionCall` | Two blocks in order. |
| RS-4 | `thought:true` part with `thoughtSignature` | `thinking` block with `signature` field. |
| RS-5 | `[Action: I am calling tool X with arguments: {...}]` text | Recovered as `tool_use`, action text removed from text block. |
| RS-6 | `functionCall.args` stringified JSON | Repaired to object before emit. |

## 8. Stream transform — integration

File: `tests/integration/stream.test.ts`

Set up a fake `executeWithRetry` that yields a `Response` whose body is a `ReadableStream` of canned Gemini SSE chunks.

Assert the SSE sequence emitted matches an Anthropic-spec compliant frame order:

| # | Gemini chunks | Expect emitted events (in order) |
|---|---|---|
| ST-1 | One text chunk + finishReason STOP | `message_start, ping, content_block_start(text), content_block_delta(text_delta), content_block_stop, message_delta(end_turn), message_stop` |
| ST-2 | thought text chunk + text chunk | `message_start, ping, content_block_start(thinking), content_block_delta(thinking_delta), content_block_delta(signature_delta?), content_block_stop, content_block_start(text), ...` |
| ST-3 | functionCall chunk | `... content_block_start(tool_use), content_block_delta(input_json_delta), content_block_stop, message_delta(tool_use), message_stop` |
| ST-4 | text containing `[Action: ...]` | text up to action emitted, then synthetic `tool_use` block, then continuation. |
| ST-5 | Stream ends mid-tool-call | A `content_block_stop` is still emitted; `message_stop` is always last. |
| ST-6 | Gemini returns error mid-stream | `event: error` emitted, `message_stop` still emitted. |

## 9. Retry engine — unit (with `fetch` mocked)

File: `tests/unit/retry.test.ts`

| # | Mocked sequence | Expect |
|---|---|---|
| RT-1 | 200 OK | One call, returns res. |
| RT-2 | 503, 503, 503 across all chain models | `overloadedModels` fast-fail; throws `overloaded_error`. |
| RT-3 | 400 `thought_signature` error | Next attempt uses `stripSigs && stripThinking`. |
| RT-4 | 400 `cached content not found` | `deleteCache` called with last hash, `skipCache` flips, retry succeeds. |
| RT-5 | 400 `max output tokens exceeded (32000)` | Next attempt uses `maxOutputTokens = 28800`. |
| RT-6 | 429 → 200 | Retried, succeeds. |
| RT-7 | 403 (revoked key) | `reportKeyFailure(..., 'auth')`, rotates key. |

## 10. CI integration

Add to [package.json](package.json):
```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  }
}
```

CI step ordering:
1. `npm ci`
2. `npm run typecheck`
3. `npm run test`
4. `npm run build` (Next.js build sanity)

## 11. Out of scope (intentionally)

- Filesystem read/write tests
- Shell/bash execution tests
- Sandbox or container path tests
- Working-directory propagation tests

The gateway has no such subsystems. Tests for those concerns belong in whatever client (Claude Code / custom agent) actually executes the tools.
