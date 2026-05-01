// test history

function transformToolsToGemini(tools) {
  if (!tools || tools.length === 0) return undefined;
  
  function convertSchema(schema) {
    if (!schema) return { type: 'STRING' };
    let type = typeof schema.type === 'string' ? schema.type.toUpperCase() : 'STRING';
    if (type === 'ANY') type = 'STRING'; 
    if (type === 'NULL') type = 'STRING';
    const result = { type };
    if (schema.description) result.description = schema.description;
    if (schema.enum) result.enum = schema.enum;
    if (type === 'ARRAY' && schema.items) {
      result.items = convertSchema(schema.items);
    } else if (type === 'ARRAY' && !schema.items) {
      result.items = { type: 'STRING' };
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

function transformRequestToGemini(anthropicReq, toolIdMap) {
  let systemText = "";
  if (typeof anthropicReq.system === 'string') {
    systemText = anthropicReq.system;
  } else if (Array.isArray(anthropicReq.system)) {
    systemText = anthropicReq.system.map(s => s.text).join('\n');
  }

  const systemInstruction = systemText ? { parts: [{ text: systemText }] } : undefined;
  const contents = [];
  
  for (const msg of anthropicReq.messages || []) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts = [];

    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ text: block.text });
        } else if (block.type === 'tool_use') {
          toolIdMap.set(block.id, block.name);
          parts.push({
            functionCall: {
              name: block.name,
              args: block.input
            },
            // test if dummy signature works
            thoughtSignature: "ZHVtbXk="
          });
        } else if (block.type === 'tool_result') {
          const fnName = toolIdMap.get(block.tool_use_id) || 'unknown_tool';
          let outputObj = block.content;
          if (typeof outputObj === 'string') {
             try {
                outputObj = JSON.parse(outputObj);
             } catch(e) { }
          }
          parts.push({
            functionResponse: {
              name: fnName,
              response: {
                output: outputObj
              }
            }
          });
        }
      }
    }
    contents.push({ role, parts });
  }

  const result = { contents };
  if (systemInstruction) result.systemInstruction = systemInstruction;
  if (anthropicReq.tools && anthropicReq.tools.length > 0) {
    result.tools = transformToolsToGemini(anthropicReq.tools);
  }
  return result;
}

const req = {
  model: 'claude-sonnet-4',
  messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_123', name: 'search', input: { query: 'foo' } }
    ]},
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_123', content: "1 pattern found" }
    ]}
  ],
  tools: [
    {
      name: 'search',
      description: 'Search something',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        },
        required: ['query']
      }
    }
  ]
};

const toolIdMap = new Map();
const geminiBody = transformRequestToGemini(req, toolIdMap);
console.log("Gemini Payload:", JSON.stringify(geminiBody, null, 2));

const key = "REPLACE_WITH_YOUR_GEMINI_API_KEY"; 

async function test() {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(geminiBody)
  });
  const data = await res.json();
  console.log("Status:", res.status);
  console.log("Response:", JSON.stringify(data, null, 2));
}

test();
