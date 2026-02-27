# Deploy to a TEE

Production deployment on [dstack](https://docs.phala.network/dstack/overview) (Phala CVM):

```bash
cp dstack/.env.staging dstack/.env
# Set: JWT_SECRET, ANTHROPIC_API_KEY, PG_PASSWORD, DOMAIN, CLOUDFLARE_API_TOKEN

docker build -t ghcr.io/YOU/oauth3-proxy:latest proxy/
docker push ghcr.io/YOU/oauth3-proxy:latest
# Pin digest (attestation requires exact match):
docker inspect ghcr.io/YOU/oauth3-proxy:latest --format '{{index .RepoDigests 0}}'
# Update dstack/docker-compose.yml with digest

phala deploy --cvm-id <UUID> -c dstack/docker-compose.yml -e dstack/.env
```

The CVM runs: dstack-ingress (attested TLS via Cloudflare) → oauth3-proxy → postgres.
