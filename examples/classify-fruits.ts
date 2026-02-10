#!/usr/bin/env -S deno run --allow-net --allow-env

/**
 * Fruit Classifier - Uses Anthropic API to classify fruits
 * 
 * @skill fruit-classifier
 * @description Classifies fruits using Claude API (apple, dragonfruit, durian)
 * @secrets ANTHROPIC_API_KEY
 * @network api.anthropic.com
 * @timeout 60
 */

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: Message[];
}

interface AnthropicResponse {
  content: Array<{ text: string }>;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

async function classifyFruit(fruitName: string): Promise<string> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is required");
  }

  const request: AnthropicRequest = {
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: `Classify this fruit: "${fruitName}". Provide: botanical family, taste profile, common uses, and one interesting fact. Be concise.`
      }
    ]
  };

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic API error: ${response.status} - ${error}`);
  }

  const data = await response.json() as AnthropicResponse;
  
  return data.content[0].text;
}

// Main execution
const fruits = ["apple", "dragonfruit", "durian"];

console.log("🍎 Fruit Classification Report\n");
console.log("=" .repeat(60));

for (const fruit of fruits) {
  console.log(`\n📍 ${fruit.toUpperCase()}`);
  console.log("-".repeat(60));
  
  try {
    const classification = await classifyFruit(fruit);
    console.log(classification);
  } catch (error) {
    console.error(`Error classifying ${fruit}:`, error);
  }
  
  console.log();
}

console.log("=" .repeat(60));
console.log("✅ Classification complete!");
