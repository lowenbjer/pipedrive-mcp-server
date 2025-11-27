# Pipedrive MCP Server

This is a Model Context Protocol (MCP) server that connects to the Pipedrive API v2. It allows you to expose Pipedrive data and functionality to LLM applications like Claude.

## Features

- Read-only access to Pipedrive data
- Exposes deals, persons, organizations, and pipelines
- Includes all fields including custom fields
- Predefined prompts for common operations
- Docker support with multi-stage builds
- JWT authentication support
- Built-in rate limiting for API requests
- Advanced deal filtering (by owner, status, date range, value, etc.)

## Setup

### Standard Setup

1. Clone this repository
2. Install dependencies:
   ```
   npm install
   ```
3. (Optional) Create a `.env` file in the root directory with default configuration:
   ```
   PIPEDRIVE_API_TOKEN=your_api_token_here
   PIPEDRIVE_DOMAIN=your-company.pipedrive.com
   ```
   Note: Credentials can also be provided dynamically via request headers (see Authentication section below).
4. Build the project:
   ```
   npm run build
   ```
5. Start the server:
   ```
   npm start
   ```

### Docker Setup

#### Option 1: Using Docker Compose (standalone)

1. Copy `.env.example` to `.env` and configure your settings:
   ```bash
   PIPEDRIVE_API_TOKEN=your_api_token_here
   PIPEDRIVE_DOMAIN=your-company.pipedrive.com
   MCP_TRANSPORT=sse  # Use SSE transport for Docker
   MCP_PORT=3000
   ```
2. Build and run with Docker Compose:
   ```bash
   docker-compose up -d
   ```
3. The server will be available at `http://localhost:3000`
   - SSE endpoint: `http://localhost:3000/sse`
   - Health check: `http://localhost:3000/health`

#### Option 2: Using Pre-built Docker Image

Pull and run the pre-built image from GitHub Container Registry:

**For SSE transport (HTTP access):**
```bash
docker run -d \
  -p 3000:3000 \
  -e PIPEDRIVE_API_TOKEN=your_api_token_here \
  -e PIPEDRIVE_DOMAIN=your-company.pipedrive.com \
  -e MCP_TRANSPORT=sse \
  -e MCP_PORT=3000 \
  ghcr.io/juhokoskela/pipedrive-mcp-server:main
```

**For stdio transport (local use):**
```bash
docker run -i \
  -e PIPEDRIVE_API_TOKEN=your_api_token_here \
  -e PIPEDRIVE_DOMAIN=your-company.pipedrive.com \
  ghcr.io/juhokoskela/pipedrive-mcp-server:main
```

#### Option 3: Integrating into Existing Project

Add the MCP server to your existing application's `docker-compose.yml`:

```yaml
services:
  # Your existing services...

  pipedrive-mcp-server:
    image: ghcr.io/juhokoskela/pipedrive-mcp-server:main
    container_name: pipedrive-mcp-server
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - PIPEDRIVE_API_TOKEN=${PIPEDRIVE_API_TOKEN}
      - PIPEDRIVE_DOMAIN=${PIPEDRIVE_DOMAIN}
      - MCP_TRANSPORT=sse
      - MCP_PORT=3000
      - PIPEDRIVE_RATE_LIMIT_MIN_TIME_MS=${PIPEDRIVE_RATE_LIMIT_MIN_TIME_MS:-250}
      - PIPEDRIVE_RATE_LIMIT_MAX_CONCURRENT=${PIPEDRIVE_RATE_LIMIT_MAX_CONCURRENT:-2}
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:3000/health", "||", "exit", "1"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

Then add the required environment variables to your `.env` file.

### Authentication

This MCP server supports **dynamic token-based authentication** (MCP-compliant). Credentials can be provided in two ways:

#### 1. Request Headers (MCP-Compliant for HTTP/SSE transport)

When using HTTP/SSE transport, provide credentials via the `Authorization` header (MCP-compliant):

**Primary method (MCP-compliant):**
```
Authorization: Bearer <apiToken>:<domain>
```

**MCP-compliant**: Only the `Authorization` header is supported. Custom headers and environment variables are not accepted for HTTP/SSE transport.

Credentials are stored per-session, so each connection can use different credentials.

#### 2. Environment Variables (Stdio Transport Only)

For stdio transport only, you can set default credentials as a fallback:

- `PIPEDRIVE_API_TOKEN` - Your Pipedrive API token (optional, stdio only)
- `PIPEDRIVE_DOMAIN` - Your Pipedrive domain (e.g., `your-company.pipedrive.com`) (optional, stdio only)

**Note:** For HTTP/SSE transport, credentials must be provided via `Authorization` header in every request. Environment variables are not used.

### Environment Variables

Optional (Stdio Transport Only - Default Credentials):
- `PIPEDRIVE_API_TOKEN` - Default Pipedrive API token (only used for stdio transport, not HTTP/SSE)
- `PIPEDRIVE_DOMAIN` - Default Pipedrive domain (only used for stdio transport, not HTTP/SSE)

Optional (JWT Authentication):
- `MCP_JWT_SECRET` - JWT secret for authentication
- `MCP_JWT_TOKEN` - JWT token for authentication
- `MCP_JWT_ALGORITHM` - JWT algorithm (default: HS256)
- `MCP_JWT_AUDIENCE` - JWT audience
- `MCP_JWT_ISSUER` - JWT issuer

When JWT authentication is enabled, all SSE requests (`/sse` and the message endpoint) must include an `Authorization: Bearer <token>` header signed with the configured secret.

Optional (Rate Limiting):
- `PIPEDRIVE_RATE_LIMIT_MIN_TIME_MS` - Minimum time between requests in milliseconds (default: 250)
- `PIPEDRIVE_RATE_LIMIT_MAX_CONCURRENT` - Maximum concurrent requests (default: 2)

Optional (Transport Configuration):
- `MCP_TRANSPORT` - Transport type: `stdio` (default, for local use), `sse` (for SSE/HTTP access with persistent connections), or `http` (for stateless HTTP requests)
- `PORT` - Port for HTTP/SSE transport (Railway-compatible, defaults to `MCP_PORT` or 3000, only used when `MCP_TRANSPORT=sse` or `http`)
- `MCP_PORT` - Port for HTTP/SSE transport (default: 3000, only used when `MCP_TRANSPORT=sse` or `http`, overridden by `PORT`)
- `MCP_ENDPOINT` - Message endpoint path (default: /message, only used when `MCP_TRANSPORT=sse` or `http`)

## Using with Claude

### For Claude Desktop (stdio transport)

1. Configure Claude for Desktop by editing your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pipedrive": {
      "command": "node",
      "args": ["/path/to/pipedrive-mcp-server/build/index.js"],
      "env": {
        "PIPEDRIVE_API_TOKEN": "your_api_token_here",
        "PIPEDRIVE_DOMAIN": "your-company.pipedrive.com"
      }
    }
  }
}
```

2. Restart Claude for Desktop
3. In the Claude application, you should now see the Pipedrive tools available

### For HTTP/SSE transport (MCP-compliant)

#### SSE Mode (`MCP_TRANSPORT=sse`)
For persistent connections with Server-Sent Events:
1. Connect to `/sse` endpoint to establish a session
2. POST to `/message` endpoint with the sessionId
3. Credentials can be provided once during SSE connection

#### HTTP Mode (`MCP_TRANSPORT=http`)
For stateless HTTP requests (simpler, no SSE connection needed):
1. POST directly to `/message` endpoint
2. Credentials must be provided in every request

**Configuration:**
- **Transport**: `http` or `sse`
- **URL**: `https://your-server.com/message` (or your Railway deployment URL)
- **With Auth Setup**: Enabled
- **API Key**: Use this format:
  - `your-api-token:your-domain` (e.g., `abc123:mycompany.pipedrive.com`)

**Example:**
If your API token is `abc123xyz` and domain is `mycompany.pipedrive.com`, send:
```
Bearer abc123xyz:mycompany.pipedrive.com
```

See [AUTHENTICATION.md](./AUTHENTICATION.md) for detailed authentication guide.

## Available Tools

- `get-users`: Get all users/owners from Pipedrive to identify owner IDs for filtering
- `get-deals`: Get deals with flexible filtering options (search by title, date range, owner, stage, status, value range, etc.)
- `get-deal`: Get a specific deal by ID (including custom fields)
- `get-deal-notes`: Get detailed notes and custom booking details for a specific deal
- `search-deals`: Search deals by term
- `get-persons`: Get all persons from Pipedrive (including custom fields)
- `get-person`: Get a specific person by ID (including custom fields)
- `search-persons`: Search persons by term
- `get-organizations`: Get all organizations from Pipedrive (including custom fields)
- `get-organization`: Get a specific organization by ID (including custom fields)
- `search-organizations`: Search organizations by term
- `get-pipelines`: Get all pipelines from Pipedrive
- `get-pipeline`: Get a specific pipeline by ID
- `get-stages`: Get all stages from all pipelines
- `search-leads`: Search leads by term
- `search-all`: Search across all item types (deals, persons, organizations, etc.)

## Available Prompts

- `list-all-deals`: List all deals in Pipedrive
- `list-all-persons`: List all persons in Pipedrive
- `list-all-pipelines`: List all pipelines in Pipedrive
- `analyze-deals`: Analyze deals by stage
- `analyze-contacts`: Analyze contacts by organization
- `analyze-leads`: Analyze leads by status
- `compare-pipelines`: Compare different pipelines and their stages
- `find-high-value-deals`: Find high-value deals

## Railway Deployment

This server is Railway-compatible and can be deployed directly:

1. Connect your GitHub repository to Railway
2. Railway will automatically detect the Node.js project and build it
3. Set environment variables in Railway dashboard (optional, for default credentials):
   - `PIPEDRIVE_API_TOKEN` (optional)
   - `PIPEDRIVE_DOMAIN` (optional)
   - `MCP_TRANSPORT=sse` (required for HTTP access)
4. Railway will automatically set the `PORT` environment variable
5. Your server will be available at the Railway-provided URL

The server will use the `PORT` environment variable provided by Railway, making it fully compatible with Railway's deployment platform.

## License

MIT
