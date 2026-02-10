/**
 * @skill classify-language
 * @description Classifies the language of a given text string using Claude API
 * @secrets ANTHROPIC_API_KEY
 * @network api.anthropic.com
 * @timeout 30
 */

const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
if (!apiKey) {
  console.error("❌ Missing ANTHROPIC_API_KEY");
  Deno.exit(1);
}

// Test strings in various languages
const testStrings = [
  "Hello, how are you today?",
  "Bonjour, comment allez-vous?",
  "Hola, ¿cómo estás?",
  "こんにちは、元気ですか？",
  "Привет, как дела?"
];

console.log("🌍 Language Classification Tool\n");
console.log("=" .repeat(60));

for (const text of testStrings) {
  console.log(`\n📝 Text: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
  
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 100,
        messages: [{
          role: "user",
          content: `Identify the language of this text. Respond with ONLY the language name (e.g., "English", "French", "Spanish", "Japanese", "Russian"). Text: "${text}"`
        }]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ API Error: ${response.status} ${response.statusText}`);
      console.error(errorText);
      continue;
    }

    const data = await response.json();
    
    if (!data.content || !data.content[0] || !data.content[0].text) {
      console.error("❌ Unexpected response structure");
      console.error(JSON.stringify(data, null, 2));
      continue;
    }

    const language = data.content[0].text.trim();
    console.log(`🌐 Language: ${language}`);
    
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
  }
}

console.log("\n" + "=".repeat(60));
console.log("✅ Classification complete!");
