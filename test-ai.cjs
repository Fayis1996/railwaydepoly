const OpenAI = require('openai');
const openai = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: 'sk-62dd4f93aa9844199c1a71acce35c911'
});

async function test() {
  const trainNo = '12617';
  const prompt = `You are a strict Indian Railways API. Your ONLY job is to output the EXACT official train route (schedule) for train number ${trainNo} (Mangala Lakshadweep Express).
Return a JSON array of objects, ordered from the very first station to the final destination.
Format: [{"sequence": 1, "code": "ERS", "name": "Ernakulam Junction"}, ...]
Do NOT invent stations. Use your factual knowledge of the real route.
Return ONLY raw JSON. No markdown wrappers.`;

  const completion = await openai.chat.completions.create({
    model: "deepseek-chat",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.1,
  });
  console.log(completion.choices[0].message.content);
}
test();
