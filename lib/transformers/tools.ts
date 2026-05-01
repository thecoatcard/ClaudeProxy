// Gemini's functionDeclarations schema accepts only a small whitelist of
// JSON-Schema fields. Anything else (e.g. `additionalProperties`, `$schema`,
// `default`, `$ref`, `oneOf`) causes a 400 "Request contains an invalid
// argument". This module converts Anthropic/JSON-Schema tool input_schemas
// into a shape Gemini will accept.

const GEMINI_TYPES = new Set(['STRING', 'NUMBER', 'INTEGER', 'BOOLEAN', 'ARRAY', 'OBJECT']);

function normalizeType(rawType: any): { type: string; nullable?: boolean } {
  // JSON Schema allows type as an array, e.g. ["string", "null"]
  if (Array.isArray(rawType)) {
    const nonNull = rawType.filter(t => t && String(t).toLowerCase() !== 'null');
    const nullable = rawType.some(t => String(t).toLowerCase() === 'null');
    const picked = nonNull[0] ? String(nonNull[0]).toUpperCase() : 'STRING';
    return { type: GEMINI_TYPES.has(picked) ? picked : 'STRING', nullable: nullable || undefined };
  }
  if (typeof rawType !== 'string') return { type: 'STRING' };
  let t = rawType.toUpperCase();
  if (t === 'ANY' || t === 'NULL') t = 'STRING';
  if (t === 'FLOAT' || t === 'DOUBLE') t = 'NUMBER';
  if (t === 'LONG') t = 'INTEGER';
  if (!GEMINI_TYPES.has(t)) t = 'STRING';
  return { type: t };
}

function convertSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return { type: 'STRING' };

  // Flatten oneOf/anyOf/allOf by picking the first branch — Gemini has no union.
  const branch = schema.oneOf?.[0] ?? schema.anyOf?.[0] ?? schema.allOf?.[0];
  if (branch && typeof branch === 'object') {
    return convertSchema({ ...schema, ...branch, oneOf: undefined, anyOf: undefined, allOf: undefined });
  }

  // `const` is equivalent to a single-value enum
  if (schema.const !== undefined && !schema.enum) {
    schema = { ...schema, enum: [schema.const] };
  }

  const { type, nullable } = normalizeType(schema.type);
  const result: any = { type };

  if (typeof schema.description === 'string' && schema.description) result.description = schema.description;
  if (nullable || schema.nullable === true) result.nullable = true;

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    // Gemini requires enum values to be strings
    result.enum = schema.enum.map((v: any) => (typeof v === 'string' ? v : JSON.stringify(v)));
    // enum is only valid on STRING in Gemini
    result.type = 'STRING';
  }

  if (type === 'STRING' && typeof schema.format === 'string') {
    // Only pass formats Gemini accepts
    if (schema.format === 'date-time' || schema.format === 'enum') result.format = schema.format;
  }
  if ((type === 'NUMBER' || type === 'INTEGER') && typeof schema.format === 'string') {
    if (['float', 'double', 'int32', 'int64'].includes(schema.format)) result.format = schema.format;
  }

  if (result.type === 'ARRAY') {
    result.items = schema.items ? convertSchema(schema.items) : { type: 'STRING' };
  }

  if (result.type === 'OBJECT') {
    // Gemini REQUIRES a `properties` field on OBJECT (even if empty).
    const props: Record<string, any> = {};
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [k, v] of Object.entries(schema.properties)) {
        props[k] = convertSchema(v);
      }
    }
    result.properties = props;
    if (Array.isArray(schema.required) && schema.required.length > 0) {
      // Only keep required names that actually exist in properties
      const existing = schema.required.filter((r: any) => typeof r === 'string' && r in props);
      if (existing.length > 0) result.required = existing;
    }
  }

  return result;
}

export function transformToolsToGemini(tools: any[], originalNameMap?: Map<string, string>) {
  if (!tools || tools.length === 0) return undefined;

  const declarations = tools
    .filter(t => t && typeof t.name === 'string')
    .map(tool => {
      const parameters = convertSchema(tool.input_schema || { type: 'object', properties: {} });
      const sanitizedName = tool.name.replace(/[^a-zA-Z0-9_]/g, '_');
      
      if (originalNameMap) {
        originalNameMap.set(sanitizedName, tool.name);
      }

      const decl: any = {
        name: sanitizedName,
        description: tool.description || '',
      };

      // Gemini rejects parameters that are an OBJECT with no properties.
      // For zero-argument tools, omit `parameters` entirely (the field is optional).
      const hasProps =
        parameters.type === 'OBJECT' &&
        parameters.properties &&
        Object.keys(parameters.properties).length > 0;

      if (hasProps) {
        decl.parameters = parameters;
      }
      return decl;
    });

  if (declarations.length === 0) return undefined;
  return [{ functionDeclarations: declarations }];
}
