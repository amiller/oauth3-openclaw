/**
 * @skill test-anthropic
 * @description Simple Anthropic API test
 * @secrets ANTHROPIC_API_KEY
 * @network api.anthropic.com
 * @timeout 30
 */

const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
if (!apiKey) {
  console.error("Missing ANTHROPIC_API_KEY");
  Deno.exit(1);
}

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

const data = await response.json();
console.log("🍎 Fruit Classification:");
console.log(data.content[0].text);
console.log("\n✅ Complete!");
