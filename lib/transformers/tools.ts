export function transformToolsToGemini(tools: any[]) {
  if (!tools || tools.length === 0) return undefined;
  
  function convertSchema(schema: any): any {
    if (!schema) return { type: 'STRING' };
    let type = typeof schema.type === 'string' ? schema.type.toUpperCase() : 'STRING';
    
    // Gemini doesn't support ANY, replace with STRING or a generic OBJECT
    if (type === 'ANY') type = 'STRING'; 
    if (type === 'NULL') type = 'STRING'; // Gemini lacks NULL

    const result: any = { type };
    if (schema.description) result.description = schema.description;
    if (schema.enum) result.enum = schema.enum;
    
    if (type === 'ARRAY' && schema.items) {
      result.items = convertSchema(schema.items);
    } else if (type === 'ARRAY' && !schema.items) {
      result.items = { type: 'STRING' }; // Fallback
    }
    
    if (type === 'OBJECT' && schema.properties) {
      result.properties = {};
      for (const [k, v] of Object.entries(schema.properties)) {
        result.properties[k] = convertSchema(v);
      }
      if (schema.required) result.required = schema.required;
    }
    
    return result;
  }

  return [{
    functionDeclarations: tools.map(tool => {
      const parameters = tool.input_schema ? convertSchema(tool.input_schema) : { type: 'OBJECT', properties: {} };
      // Ensure top level is OBJECT
      if (parameters.type !== 'OBJECT') parameters.type = 'OBJECT';
      if (!parameters.properties) parameters.properties = {};

      return {
        name: tool.name,
        description: tool.description,
        parameters
      };
    })
  }];
}
