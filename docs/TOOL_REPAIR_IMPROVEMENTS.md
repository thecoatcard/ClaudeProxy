# TOOL_REPAIR_IMPROVEMENTS.md

[lib/transformers/repair.ts](lib/transformers/repair.ts) is solid for the common cases. Below are recommended improvements ordered by impact.

## 1. Surface `is_error` to the model (medium impact)

Today, when the client posts:
```json
{ "type": "tool_result", "tool_use_id": "...", "is_error": true, "content": "ENOENT: ..." }
```

[request.ts](lib/transformers/request.ts) emits:
```json
{ "functionResponse": { "name": "Bash", "response": { "result": "ENOENT: ..." } } }
```

The `is_error: true` flag is **dropped**. The model usually still notices because the text starts with "ENOENT:" or "Error:", but adding an explicit envelope makes it unambiguous:

```ts
parts.push({
  functionResponse: {
    name: fnName,
    response: block.is_error
      ? { ok: false, error: resultText }
      : { ok: true, result: resultText },
  },
});
```

This pairs well with the loop detector — the model has stronger signal that the prior call failed.

## 2. Schema depth guard in `convertSchema` (low impact, defensive)

[tools.ts](lib/transformers/tools.ts) `convertSchema` recurses without a depth limit. A malicious or pathological schema (very deep nesting) could blow the stack. Add:

```ts
function convertSchema(schema: any, depth = 0): any {
  if (depth > 32) return { type: 'STRING' };
  // ...recursive calls pass depth + 1
}
```

## 3. Warn on dropped union branches (low impact, observability)

When `oneOf`/`anyOf`/`allOf` is flattened to the first branch, log once per tool name so the operator can spot tools that won't behave as the client expects:

```ts
if (schema.oneOf?.length > 1 || schema.anyOf?.length > 1) {
  console.warn(`[tools] dropping union branches for tool schema, only first branch sent to Gemini`);
}
```

## 4. Reject obviously-broken `tool_use.input` shapes earlier (low impact)

[repair.ts](lib/transformers/repair.ts) coerces a non-object root to `{}`. That is correct, but the model has now lost whatever the client originally sent. Add a one-line warning so this is visible in logs:

```ts
if (typeof rawArgs !== 'object' || rawArgs === null) {
  console.warn('[repair] non-object tool args coerced to {}', { sample: String(rawArgs).slice(0, 80) });
}
```

## 5. Validate `enum` membership post-coerce (low impact)

When a schema specifies `enum: ['a','b','c']` and the model returns `"A"`, `repair.coerce` does not normalize case or reject. Adding a soft normalization step would cut down on a class of validator failures on the client side:

```ts
if (Array.isArray(schema?.enum) && schema.enum.length > 0) {
  const norm = String(value);
  const hit = schema.enum.find((e: any) => String(e).toLowerCase() === norm.toLowerCase());
  if (hit !== undefined) return hit;
  // else fall through to existing behavior
}
```

Out of scope for now (could change validated payloads); flag for future review.

## 6. Truncation marker is opaque to the model (low impact)

[request.ts](lib/transformers/request.ts) inserts:
```
... [GATEWAY: truncated 12345 chars] ...
```
This is fine for humans. To make it actionable for the model, consider:
```
... [GATEWAY: omitted 12,345 chars from middle. If you need the omitted region, call the read tool with a byte range or a search pattern.] ...
```
This makes the model more likely to issue a follow-up read with explicit offsets instead of re-issuing the same broad read.

## 7. Stable signature for the loop detector (already done)

Documented here for completeness: the loop detector uses a key-sorted JSON serializer (`stableStringify`) so `{a:1,b:2}` and `{b:2,a:1}` collide. This means a model that tries to "trick" itself by reordering keys still trips the detector.

## Not recommended

- **Auto-fixing missing files / running tools server-side.** Out of scope: the gateway is a translator, not an executor.
- **Heuristic argument suggestion** ("looks like you meant `path: ./logs/`"). Too brittle, prompts can do this better.
