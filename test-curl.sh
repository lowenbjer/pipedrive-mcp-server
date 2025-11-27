#!/bin/bash

# Test script for Pipedrive MCP Server
# Usage: ./test-curl.sh [your-api-token] [your-domain]

URL="https://pipedrive-mcp-server-production-59bb.up.railway.app"
API_TOKEN="${1:-your-api-token}"
DOMAIN="${2:-your-domain}"

echo "=========================================="
echo "Testing Pipedrive MCP Server"
echo "=========================================="
echo ""

# Test 1: Health Check
echo "1. Testing health endpoint..."
HEALTH_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" "$URL/health")
HTTP_CODE=$(echo "$HEALTH_RESPONSE" | grep "HTTP_CODE" | cut -d: -f2)
BODY=$(echo "$HEALTH_RESPONSE" | sed '/HTTP_CODE/d')

if [ "$HTTP_CODE" = "200" ]; then
  echo "✅ Health check passed!"
  echo "Response: $BODY"
else
  echo "❌ Health check failed (HTTP $HTTP_CODE)"
  echo "Response: $BODY"
  echo ""
  echo "This usually means:"
  echo "  - Server is not running"
  echo "  - MCP_TRANSPORT is not set to 'sse'"
  echo "  - Check Railway logs for errors"
  exit 1
fi

echo ""
echo "=========================================="

# Test 2: SSE Endpoint (with credentials)
echo "2. Testing SSE endpoint with credentials..."
echo "Using: Authorization: Bearer $API_TOKEN:$DOMAIN"
echo ""

SSE_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X GET "$URL/sse" \
  -H "Authorization: Bearer $API_TOKEN:$DOMAIN" \
  -H "Accept: text/event-stream" \
  --max-time 3)

HTTP_CODE=$(echo "$SSE_RESPONSE" | grep "HTTP_CODE" | cut -d: -f2)
BODY=$(echo "$SSE_RESPONSE" | sed '/HTTP_CODE/d' | head -5)

if [ "$HTTP_CODE" = "200" ]; then
  echo "✅ SSE endpoint accessible!"
  echo "First few lines:"
  echo "$BODY"
elif [ "$HTTP_CODE" = "401" ]; then
  echo "⚠️  Authentication required (401)"
  echo "This is expected if credentials are invalid"
  echo "Response: $BODY"
else
  echo "❌ SSE endpoint failed (HTTP $HTTP_CODE)"
  echo "Response: $BODY"
fi

echo ""
echo "=========================================="
echo "Test complete!"
echo ""
echo "If health check fails, check Railway:"
echo "  1. Go to Railway dashboard"
echo "  2. Check environment variables: MCP_TRANSPORT must be 'sse'"
echo "  3. Check deployment logs for errors"
echo "  4. Verify the service is running"

