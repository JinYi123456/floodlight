# Run Floodlight on Azure

The studio ships as a single container: the API service (pipeline, SSE, dataset
exports and the MCP tool surface) plus the web build it serves. It is designed
to sit on Azure Container Apps' consumption plan — scale-to-zero, inside the
service's free monthly grant (180,000 vCPU-seconds, 360,000 GiB-seconds and
2M requests), so a demo deployment costs $0.

Everything below is already wired in this repository:

- `services/api/Dockerfile` — the image (Node 22, `npm ci`, `tsx` runtime).
- `.github/workflows/api-image.yml` — builds and pushes
  `ghcr.io/jinyi123456/floodlight-api:latest` on every relevant push. The
  image is public, so Container Apps pulls it without credentials.

## Deploy (one command each)

```bash
az login                                   # once, on your machine
az group create -n rg-floodlight -l southeastasia
az containerapp env create -n floodlight-env -g rg-floodlight -l southeastasia
az containerapp create \
  -n floodlight-api -g rg-floodlight \
  --environment floodlight-env \
  --image ghcr.io/jinyi123456/floodlight-api:latest \
  --target-port 8787 --ingress external \
  --min-replicas 0 --max-replicas 2 \
  --cpu 0.5 --memory 1Gi
```

Then read the public URL and try it:

```bash
az containerapp show -n floodlight-api -g rg-floodlight --query properties.configuration.ingress.fqdn -o tsv
curl https://<fqdn>/health
curl "https://<fqdn>/matches/stream?scenario=comeback&seed=2026" | head
```

## What is live on the URL

| Route | What it is |
| --- | --- |
| `GET /health` | service banner + route index |
| `GET /scenarios` | the four synthetic matches |
| `GET /matches/prepare?scenario=&seed=` | full machine-readable production run |
| `GET /matches/stream?scenario=&seed=` | the five stages as server-sent events |
| `GET /matches/vision?scenario=&seed=` | pixel-only auto-eventing accuracy report |
| `GET /matches/events.jsonl / moments.csv / data-card` | dataset exports |
| `POST /mcp` | the nine studio tools as MCP over Streamable HTTP |

The MCP endpoint is stateless (a fresh server + transport per request), which
is what lets the app scale to zero. Attach any MCP-speaking host:

```bash
# Claude Code / mcp-client style config
"floodlight": {
  "type": "http",
  "url": "https://<fqdn>/mcp"
}
```

## Redeploys

Push to `main`; the image workflow rebuilds and pushes `:latest`, then:

```bash
az containerapp update -n floodlight-api -g rg-floodlight \
  --image ghcr.io/jinyi123456/floodlight-api:latest
```

## Tear-down

```bash
az group delete -n rg-floodlight --yes --no-wait
```
