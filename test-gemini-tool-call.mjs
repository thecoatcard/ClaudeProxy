


const key = "REPLACE_WITH_YOUR_GEMINI_API_KEY"; 

async function test() {
  const req = {
    contents: [{ role: "user", parts: [{ text: "Write a 500 word essay about the history of artificial intelligence and pass it as the query parameter to the search tool." }] }],
    tools: [{
      functionDeclarations: [{
        name: "search",
        description: "Search",
        parameters: { type: "OBJECT", properties: { query: { type: "STRING" } } }
      }]
    }]
  };

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:streamGenerateContent?key=${key}&alt=sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req)
  });
  
  const text = await res.text();
  const chunks = text.split('\n\n').filter(c => c.trim().length > 0);
  let functionCallCount = 0;
  for (const c of chunks) {
    if (c.includes('"functionCall"')) {
      functionCallCount++;
    }
  }
  console.log("Stream chunks containing functionCall:", functionCallCount);
}

test();
