// @skill deploy-cvm-api
// @description Deploy clawteedah-hello CVM using Phala Cloud REST API
// @secrets PHALA_API_KEY2
// @network cloud-api.phala.com
// @timeout 120

const apiKey = Deno.env.get("PHALA_API_KEY2");
const base = "https://cloud-api.phala.com/api/v1";
const headers = {
  "X-API-Key": apiKey!,
  "Content-Type": "application/json",
};

const dockerCompose = `services:
  app:
    image: nginx:alpine
    ports:
      - "8080:80"
    restart: unless-stopped
`;

// Step 1: Get available teepods/nodes for auto-selection
console.log("Fetching available nodes...");
const nodesResp = await fetch(`${base}/teepods/available`, { headers });
const nodesData = await nodesResp.json();
console.log("Available nodes:", JSON.stringify(nodesData).slice(0, 300));

// Step 2: Get instance types
console.log("\nFetching instance types...");
const itResp = await fetch(`${base}/instance-types`, { headers });
const itData = await itResp.json();
console.log("Instance types:", JSON.stringify(itData).slice(0, 300));

// Step 3: Provision the CVM
console.log("\nProvisioning CVM...");
const provisionBody = {
  name: "clawteedah-hello",
  instance_type: "tdx.small",
  compose_file: {
    docker_compose_file: dockerCompose,
    name: "clawteedah-hello",
    kms_enabled: true,
    public_logs: true,
    public_sysinfo: true,
    gateway_enabled: true,
    tproxy_enabled: true,
  },
  listed: false,
};

const provResp = await fetch(`${base}/cvms/provision`, {
  method: "POST",
  headers,
  body: JSON.stringify(provisionBody),
});

const provData = await provResp.json();
console.log("Provision response:", JSON.stringify(provData, null, 2));

if (!provResp.ok) {
  console.error("Provision failed:", provResp.status);
  Deno.exit(1);
}
