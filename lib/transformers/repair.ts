// Repair Gemini functionCall.args so they satisfy the original Anthropic
// tool input_schema before we emit a tool_use block. Claude Code validates
// tool_use.input against input_schema and raises "Invalid tool parameters"
// on any drift — wrong types, missing required fields, stringified JSON,
// non-object roots, etc. We coerce here so Claude never sees the drift.

type JsonSchema = any;

function primaryType(schema: JsonSchema): string {
  if (!schema) return 'string';
  const t = schema.type;
  if (Array.isArray(t)) {
    const nonNull = t.find((x: any) => x && String(x).toLowerCase() !== 'null');
    return nonNull ? String(nonNull).toLowerCase() : 'string';
  }
  if (typeof t === 'string') return t.toLowerCase();
  // Inferred object if `properties` exists, array if `items` exists
  if (schema.properties) return 'object';
  if (schema.items) return 'array';
  return 'string';
}

function isNullable(schema: JsonSchema): boolean {
  if (!schema) return false;
  if (schema.nullable === true) return true;
  if (Array.isArray(schema.type) && schema.type.some((x: any) => String(x).toLowerCase() === 'null')) return true;
  return false;
}

function defaultFor(type: string): any {
  switch (type) {
    case 'string': return '';
    case 'integer':
    case 'number': return 0;
    case 'boolean': return false;
    case 'array': return [];
    case 'object': return {};
    default: return null;
  }
}

function coerce(value: any, schema: JsonSchema): any {
  const type = primaryType(schema);

  if (value === null || value === undefined) {
    return isNullable(schema) ? null : defaultFor(type);
  }

  switch (type) {
    case 'object': {
      let obj = value;
      // Gemini occasionally returns a stringified JSON object.
      if (typeof obj === 'string') {
        try { obj = JSON.parse(obj); } catch { return defaultFor('object'); }
      }
      if (typeof obj !== 'object' || Array.isArray(obj)) return defaultFor('object');

      const props = schema?.properties || {};
      const result: Record<string, any> = {};

      // Recurse on known props, preserve unknown props as-is (permissive).
      for (const [k, v] of Object.entries(obj)) {
        result[k] = props[k] ? coerce(v, props[k]) : v;
      }

      // Fill missing required fields with type-appropriate defaults so Claude
      // doesn't reject the tool_use outright. Prefer schema.default when set.
      if (Array.isArray(schema?.required)) {
        for (const req of schema.required) {
          if (result[req] === undefined) {
            const sub = props[req];
            if (sub && 'default' in sub) {
              result[req] = sub.default;
            } else {
              result[req] = defaultFor(primaryType(sub));
            }
          }
        }
      }
      return result;
    }

    case 'array': {
      let arr = value;
      if (typeof arr === 'string') {
        try {
          const parsed = JSON.parse(arr);
          arr = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          return [];
        }
      }
      if (!Array.isArray(arr)) return [arr];
      return schema?.items ? arr.map((v: any) => coerce(v, schema.items)) : arr;
    }

    case 'integer':
    case 'number': {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return type === 'integer' ? Math.trunc(value) : value;
      }
      if (typeof value === 'string') {
        const n = type === 'integer' ? parseInt(value, 10) : parseFloat(value);
        return Number.isFinite(n) ? n : 0;
      }
      if (typeof value === 'boolean') return value ? 1 : 0;
      return 0;
    }

    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const s = value.toLowerCase().trim();
        if (s === 'true' || s === '1' || s === 'yes') return true;
        if (s === 'false' || s === '0' || s === 'no' || s === '') return false;
      }
      if (typeof value === 'number') return value !== 0;
      return false;
    }

    case 'string':
    default: {
      if (typeof value === 'string') return value;
      if (value === null || value === undefined) return '';
      if (typeof value === 'object') {
        try { return JSON.stringify(value); } catch { return ''; }
      }
      return String(value);
    }
  }
}

export function repairToolInput(rawArgs: any, schema: JsonSchema | undefined): Record<string, any> {
  // Top level must always be a plain object.
  let args = rawArgs;

  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = {}; }
  }
  if (args === null || args === undefined) args = {};
  if (Array.isArray(args)) args = { items: args };
  if (typeof args !== 'object') args = {};

  if (!schema) return args;

  const coerced = coerce(args, schema);
  return coerced && typeof coerced === 'object' && !Array.isArray(coerced) ? coerced : {};
}
