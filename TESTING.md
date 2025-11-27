# Testing Guide

## Required Environment Variables for Railway

For Railway deployment, you **MUST** set:

```bash
MCP_TRANSPORT=sse
```

**This is critical!** Without it, the server will default to `stdio` transport which won't work over HTTP and will cause a 502 error.

### Why 502 Errors Happen

A 502 Bad Gateway error typically means:
1. **Missing `MCP_TRANSPORT=sse`** - Server defaults to stdio (won't work over HTTP)
2. **Server crashed on startup** - Check Railway logs
3. **Port mismatch** - Railway sets `PORT` automatically, server should use it
4. **Build failed** - Check build logs in Railway

### Optional Environment Variables

These are optional but recommended:

```bash
# Default credentials (fallback if not provided in headers)
PIPEDRIVE_API_TOKEN=your_api_token_here
PIPEDRIVE_DOMAIN=your-company.pipedrive.com

# Port (Railway sets PORT automatically, but you can override)
PORT=3000
# or
MCP_PORT=3000

# Rate limiting (optional)
PIPEDRIVE_RATE_LIMIT_MIN_TIME_MS=250
PIPEDRIVE_RATE_LIMIT_MAX_CONCURRENT=2
```

## Testing with curl

### 1. Health Check

First, test if the server is running:

```bash
curl https://pipedrive-mcp-server-production-59bb.up.railway.app/health
```

Expected response:
```json
{"status":"ok","transport":"sse"}
```

### 2. Test SSE Endpoint (with credentials)

```bash
# Using Authorization header (plain format)
curl -X GET "https://pipedrive-mcp-server-production-59bb.up.railway.app/sse" \
  -H "Authorization: Bearer YOUR_API_TOKEN:YOUR_DOMAIN" \
  -H "Accept: text/event-stream" \
  -N

# Using Authorization header (base64 format)
curl -X GET "https://pipedrive-mcp-server-production-59bb.up.railway.app/sse" \
  -H "Authorization: Bearer $(echo -n 'YOUR_API_TOKEN:YOUR_DOMAIN' | base64)" \
  -H "Accept: text/event-stream" \
  -N

# Using custom headers
curl -X GET "https://pipedrive-mcp-server-production-59bb.up.railway.app/sse" \
  -H "X-Pipedrive-API-Token: YOUR_API_TOKEN" \
  -H "X-Pipedrive-Domain: YOUR_DOMAIN" \
  -H "Accept: text/event-stream" \
  -N
```

### 3. Test Message Endpoint

```bash
# Get session ID from SSE connection first, then:
curl -X POST "https://pipedrive-mcp-server-production-59bb.up.railway.app/message?sessionId=YOUR_SESSION_ID" \
  -H "Authorization: Bearer YOUR_API_TOKEN:YOUR_DOMAIN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": {
        "name": "test-client",
        "version": "1.0.0"
      }
    }
  }'
```

## Troubleshooting 502 Error

A 502 error usually means the server isn't starting. Check:

1. **Is MCP_TRANSPORT set to 'sse'?**
   ```bash
   # In Railway dashboard, check environment variables
   MCP_TRANSPORT=sse
   ```

2. **Check Railway logs:**
   - Go to Railway dashboard → Your service → Deployments → View logs
   - Look for startup errors

3. **Common issues:**
   - Missing `MCP_TRANSPORT=sse` → Server tries to use stdio (won't work over HTTP)
   - Port mismatch → Railway sets PORT, server should use it
   - Build errors → Check build logs

4. **Verify the server is listening:**
   ```bash
   # Check if health endpoint responds
   curl https://pipedrive-mcp-server-production-59bb.up.railway.app/health
   ```

## Quick Test Script

Save this as `test.sh`:

```bash
#!/bin/bash

URL="https://pipedrive-mcp-server-production-59bb.up.railway.app"
API_TOKEN="your-api-token"
DOMAIN="your-domain"

echo "Testing health endpoint..."
curl -s "$URL/health" | jq .

echo -e "\nTesting SSE endpoint..."
curl -X GET "$URL/sse" \
  -H "Authorization: Bearer $API_TOKEN:$DOMAIN" \
  -H "Accept: text/event-stream" \
  -N \
  --max-time 5
```

Make it executable and run:
```bash
chmod +x test.sh
./test.sh
```

