// @skill phala-list-cvms
// @description List all CVMs on Phala Cloud
// @secrets PHALA_API_KEY2
// @network cloud.phala.network
// @timeout 30

const apiKey = Deno.env.get("PHALA_API_KEY2");
const headers = {
  "X-API-Key": apiKey!,
  "Content-Type": "application/json"
};

const resp = await fetch("https://cloud.phala.network/api/v1/cvms", { headers });
const data = await resp.json();
console.log(JSON.stringify(data, null, 2));
