/**
 * OAuth3 Skill Template
 * 
 * 🤖 Not sure if this code is safe?
 * Discuss with Claude: https://claude.ai/new?q=Review%20this%20code%20for%20security
 * 
 * @skill example-skill
 * @description A simple example skill that demonstrates the OAuth3 pattern
 * @secrets EXAMPLE_API_KEY
 * @network api.example.com
 * @timeout 30
 */

// Example: Call an API with injected secret
const apiKey = Deno.env.get("EXAMPLE_API_KEY");

if (!apiKey) {
  console.error("Missing EXAMPLE_API_KEY");
  Deno.exit(1);
}

try {
  const response = await fetch("https://api.example.com/v1/endpoint", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: "Hello from OAuth3!"
    })
  });

  const data = await response.json();
  console.log("Success:", JSON.stringify(data, null, 2));
} catch (error) {
  console.error("Error:", error.message);
  Deno.exit(1);
}
