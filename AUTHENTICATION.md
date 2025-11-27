# Authentication Guide

## What Token to Send

For Pipedrive MCP server, you need to send **both** your Pipedrive API token and domain. Here are the supported formats:

### Option 1: Authorization Header (Recommended - MCP Compliant)

**Format 1: Plain text (easiest)**
```
Authorization: Bearer <your-api-token>:<your-domain>
```

**Example:**
```
Authorization: Bearer abc123xyz:mycompany.pipedrive.com
```

**Format 2: Base64 encoded (more secure)**
```
Authorization: Bearer <base64-encoded-string>
```

To create the base64 token:
```bash
# In terminal:
echo -n "your-api-token:your-domain" | base64

# Example:
echo -n "abc123xyz:mycompany.pipedrive.com" | base64
# Output: YWJjMTIzeHl6Om15Y29tcGFueS5waXBlZHJpdmUuY29t
```

Then send:
```
Authorization: Bearer YWJjMTIzeHl6Om15Y29tcGFueS5waXBlZHJpdmUuY29t
```

### Option 2: Custom Headers (Fallback)

If your MCP client doesn't support custom Authorization header format, use these headers:

```
X-Pipedrive-API-Token: your-api-token
X-Pipedrive-Domain: your-domain
```

Or:
```
X-API-Token: your-api-token
X-Domain: your-domain
```

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
- **API Key**: Use one of these formats:
  - Plain: `your-api-token:your-domain`
  - Base64: `YWJjMTIzeHl6Om15Y29tcGFueS5waXBlZHJpdmUuY29t` (base64 of `token:domain`)

## Testing

You can test the authentication with curl:

```bash
# Test with plain format
curl -X GET "https://your-server.com/sse" \
  -H "Authorization: Bearer your-api-token:your-domain"

# Test with base64 format
curl -X GET "https://your-server.com/sse" \
  -H "Authorization: Bearer $(echo -n 'your-api-token:your-domain' | base64)"

# Test with custom headers
curl -X GET "https://your-server.com/sse" \
  -H "X-Pipedrive-API-Token: your-api-token" \
  -H "X-Pipedrive-Domain: your-domain"
```

## Notes

- The server will try Authorization header first, then fall back to custom headers
- Credentials are stored per-session, so each connection can use different credentials
- If no credentials are provided, the server will use environment variables (if set)

