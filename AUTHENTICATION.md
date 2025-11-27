# Authentication Guide

## What Token to Send

For Pipedrive MCP server, you need to send **both** your Pipedrive API token and domain. Here are the supported formats:

### Option 1: Authorization Header (Recommended - MCP Compliant)

**Format: Plain text**
```
Authorization: Bearer <your-api-token>:<your-domain>
```

**Example:**
```
Authorization: Bearer abc123xyz:mycompany.pipedrive.com
```

**Note:** This server follows MCP specification and only accepts credentials via the `Authorization` header. Custom headers and environment variables are not supported for HTTP/SSE transport.

## Where to Get Your Credentials

1. **Pipedrive API Token**: 
   - Go to Pipedrive Settings → Personal → API
   - Copy your API token

2. **Pipedrive Domain**: 
   - Your company's Pipedrive subdomain
   - Example: `mycompany.pipedrive.com`
   - Found in your Pipedrive URL: `https://mycompany.pipedrive.com`

## MCP Client Configuration

When configuring in your MCP client (like the one shown in your screenshot):

- **Transport**: `http` or `sse`
- **URL**: `https://your-railway-url.com/message` (or `/sse` for SSE endpoint)
- **With Auth Setup**: Enabled
- **API Key**: Use this format:
  - `your-api-token:your-domain` (plain text, colon-separated)

## Testing

You can test the authentication with curl:

```bash
# Test with Authorization header
curl -X GET "https://your-server.com/sse" \
  -H "Authorization: Bearer your-api-token:your-domain"

```

## Notes

- **MCP-compliant**: Only `Authorization: Bearer token:domain` header is supported
- Credentials are stored per-session, so each connection can use different credentials
- For HTTP/SSE transport: Credentials must be provided in every request via Authorization header
- For stdio transport: Environment variables (`PIPEDRIVE_API_TOKEN`, `PIPEDRIVE_DOMAIN`) can be used as fallback

