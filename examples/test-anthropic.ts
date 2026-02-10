/**
 * @skill test-anthropic
 * @description Simple Anthropic API test with error handling
 * @secrets ANTHROPIC_API_KEY
 * @network api.anthropic.com
 * @timeout 30
 */

const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
if (!apiKey) {
  console.error("Missing ANTHROPIC_API_KEY");
  Deno.exit(1);
}

console.log("📡 Calling Anthropic API...");

const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01"
  },
  body: JSON.stringify({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 256,
    messages: [{
      role: "user",
      content: "Classify these three fruits in one sentence each: apple, dragonfruit, durian."
    }]
  })
});

console.log(`Status: ${response.status} ${response.statusText}`);

const data = await response.json();

if (!response.ok) {
  console.error("❌ API Error:");
  console.error(JSON.stringify(data, null, 2));
  Deno.exit(1);
}

if (!data.content || !data.content[0] || !data.content[0].text) {
  console.error("❌ Unexpected response structure:");
  console.error(JSON.stringify(data, null, 2));
  Deno.exit(1);
}

console.log("\n🍎 Fruit Classification:");
console.log(data.content[0].text);
console.log("\n✅ Complete!");
