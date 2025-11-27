import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import * as pipedrive from "pipedrive";
import * as dotenv from 'dotenv';
import Bottleneck from 'bottleneck';
import jwt from 'jsonwebtoken';
import http from 'http';
import { AsyncLocalStorage } from 'async_hooks';

// Type for error handling
interface ErrorWithMessage {
  message: string;
}

function isErrorWithMessage(error: unknown): error is ErrorWithMessage {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as Record<string, unknown>).message === 'string'
  );
}

function getErrorMessage(error: unknown): string {
  if (isErrorWithMessage(error)) {
    return error.message;
  }
  return String(error);
}

// Load environment variables
dotenv.config();

// Credentials are now optional at startup - they'll be provided per-request
// Fallback to environment variables for backward compatibility
const defaultApiToken = process.env.PIPEDRIVE_API_TOKEN;
const defaultDomain = process.env.PIPEDRIVE_DOMAIN;

const jwtSecret = process.env.MCP_JWT_SECRET;
const jwtAlgorithm = (process.env.MCP_JWT_ALGORITHM || 'HS256') as jwt.Algorithm;
const jwtVerifyOptions = {
  algorithms: [jwtAlgorithm],
  audience: process.env.MCP_JWT_AUDIENCE,
  issuer: process.env.MCP_JWT_ISSUER,
};

if (jwtSecret) {
  const bootToken = process.env.MCP_JWT_TOKEN;
  if (!bootToken) {
    console.error("ERROR: MCP_JWT_TOKEN environment variable is required when MCP_JWT_SECRET is set");
    process.exit(1);
  }

  try {
    jwt.verify(bootToken, jwtSecret, jwtVerifyOptions);
  } catch (error) {
    console.error("ERROR: Failed to verify MCP_JWT_TOKEN", error);
    process.exit(1);
  }
}

const verifyRequestAuthentication = (req: http.IncomingMessage) => {
  if (!jwtSecret) {
    return { ok: true } as const;
  }

  const header = req.headers['authorization'];
  if (!header) {
    return { ok: false, status: 401, message: 'Missing Authorization header' } as const;
  }

  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return { ok: false, status: 401, message: 'Invalid Authorization header format' } as const;
  }

  try {
    jwt.verify(token, jwtSecret, jwtVerifyOptions);
    return { ok: true } as const;
  } catch (error) {
    return { ok: false, status: 401, message: 'Invalid or expired token' } as const;
  }
};

const limiter = new Bottleneck({
  minTime: Number(process.env.PIPEDRIVE_RATE_LIMIT_MIN_TIME_MS || 250),
  maxConcurrent: Number(process.env.PIPEDRIVE_RATE_LIMIT_MAX_CONCURRENT || 2),
});

const withRateLimit = <T extends object>(client: T): T => {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') {
        return (...args: unknown[]) => limiter.schedule(() => (value as Function).apply(target, args));
      }
      return value;
    },
  });
};

// Session storage for credentials and API clients
interface SessionCredentials {
  apiToken: string;
  domain: string;
  apiClient: pipedrive.ApiClient;
  dealsApi: pipedrive.DealsApi;
  personsApi: pipedrive.PersonsApi;
  organizationsApi: pipedrive.OrganizationsApi;
  pipelinesApi: pipedrive.PipelinesApi;
  itemSearchApi: pipedrive.ItemSearchApi;
  leadsApi: pipedrive.LeadsApi;
  activitiesApi: any;
  notesApi: any;
  usersApi: any;
}

const sessions = new Map<string, SessionCredentials>();
const sessionContext = new AsyncLocalStorage<string>();

// Create API clients for a given session
function createApiClients(apiToken: string, domain: string): SessionCredentials {
  const apiClient = new pipedrive.ApiClient();
  apiClient.basePath = `https://${domain}/api/v1`;
  apiClient.authentications = apiClient.authentications || {};
  apiClient.authentications['api_key'] = {
    type: 'apiKey',
    'in': 'query',
    name: 'api_token',
    apiKey: apiToken
  };

  return {
    apiToken,
    domain,
    apiClient,
    dealsApi: withRateLimit(new pipedrive.DealsApi(apiClient)),
    personsApi: withRateLimit(new pipedrive.PersonsApi(apiClient)),
    organizationsApi: withRateLimit(new pipedrive.OrganizationsApi(apiClient)),
    pipelinesApi: withRateLimit(new pipedrive.PipelinesApi(apiClient)),
    itemSearchApi: withRateLimit(new pipedrive.ItemSearchApi(apiClient)),
    leadsApi: withRateLimit(new pipedrive.LeadsApi(apiClient)),
    // @ts-ignore - ActivitiesApi exists but may not be in type definitions
    activitiesApi: withRateLimit(new (pipedrive as any).ActivitiesApi(apiClient)),
    // @ts-ignore - NotesApi exists but may not be in type definitions
    notesApi: withRateLimit(new (pipedrive as any).NotesApi(apiClient)),
    // @ts-ignore - UsersApi exists but may not be in type definitions
    usersApi: withRateLimit(new (pipedrive as any).UsersApi(apiClient)),
  };
}

// Get or create session credentials
// MCP-compliant: Credentials must be provided (no environment variable fallback for HTTP/SSE)
function getSessionCredentials(sessionId: string, apiToken?: string, domain?: string): SessionCredentials {
  console.error(`[DEBUG] getSessionCredentials called - sessionId: ${sessionId}, hasToken: ${!!apiToken}, hasDomain: ${!!domain}`);
  
  // Try to get existing session
  if (sessions.has(sessionId)) {
    console.error(`[DEBUG] Using existing session credentials for ${sessionId}`);
    return sessions.get(sessionId)!;
  }

  // For stdio transport, allow environment variable fallback
  if (transportType === 'stdio') {
    const token = apiToken || defaultApiToken;
    const dom = domain || defaultDomain;
    
    if (!token || !dom) {
      console.error('[DEBUG] Stdio transport: Missing credentials (no token or domain)');
      throw new Error('Pipedrive API credentials are required. For stdio transport, provide via Authorization header or set PIPEDRIVE_API_TOKEN and PIPEDRIVE_DOMAIN environment variables.');
    }
    
    console.error(`[DEBUG] Creating new stdio session credentials for ${sessionId}`);
    const credentials = createApiClients(token, dom);
    sessions.set(sessionId, credentials);
    return credentials;
  }

  // For HTTP/SSE transport, credentials must be provided via Authorization header
  if (!apiToken || !domain) {
    console.error('[DEBUG] HTTP/SSE transport: Missing credentials in request');
    throw new Error('Pipedrive API credentials are required. Provide Authorization: Bearer token:domain header in your request.');
  }

  console.error(`[DEBUG] Creating new HTTP/SSE session credentials for ${sessionId} (domain: ${domain})`);
  const credentials = createApiClients(apiToken, domain);
  sessions.set(sessionId, credentials);
  console.error(`[DEBUG] Session ${sessionId} credentials created and stored. Total sessions: ${sessions.size}`);
  return credentials;
}

// Get current session credentials from context
// MCP-compliant: Credentials must be provided via Authorization header
function getCurrentSessionCredentials(): SessionCredentials {
  const sessionId = sessionContext.getStore();
  console.error(`[DEBUG] getCurrentSessionCredentials called - sessionId from context: ${sessionId || 'none'}`);
  
  // If we have a session ID from context, use it
  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (existing) {
      console.error(`[DEBUG] Found existing credentials for session ${sessionId}`);
      return existing;
    }
    // If we have sessionId but no credentials, that's an error
    console.error(`[DEBUG] Session ${sessionId} exists in context but no credentials found in sessions map`);
    throw new Error(`Session ${sessionId} exists but has no credentials. Provide credentials via Authorization: Bearer token:domain header.`);
  }
  
  // Fallback: try stdio session (for stdio transport only)
  // Note: stdio transport should use environment variables as fallback
  if (transportType === 'stdio' && sessions.has('stdio')) {
    console.error('[DEBUG] Using stdio session credentials (fallback)');
    return sessions.get('stdio')!;
  }
  
  // For HTTP/SSE transport, credentials must be provided via Authorization header
  const availableSessions = Array.from(sessions.keys());
  console.error(`[DEBUG] No session context found. Available sessions: ${availableSessions.join(', ') || 'none'}`);
  console.error(`[DEBUG] Current context sessionId: ${sessionId || 'none'}, transportType: ${transportType}`);
  
  throw new Error('No credentials found. MCP-compliant authentication requires Authorization: Bearer token:domain header in each request.');
}

// Extract credentials from request headers (MCP-compliant)
// MCP spec requires Authorization header with Bearer token
// 
// Required format:
// Authorization: Bearer <apiToken>:<domain> (plain text format)
function extractCredentialsFromRequest(req: http.IncomingMessage): { apiToken?: string; domain?: string } {
  let apiToken: string | undefined;
  let domain: string | undefined;
  
  // MCP-compliant: Only check Authorization header
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    console.error('[DEBUG] No Authorization header found in request');
    return { apiToken, domain };
  }
  
  // Handle both string and string[] (some proxies might send arrays)
  const authValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  console.error(`[DEBUG] Authorization header found: ${authValue.substring(0, 50)}...`);
  
  const match = authValue.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    // Authorization header exists but doesn't match Bearer format
    console.error('[DEBUG] Authorization header does not match Bearer format');
    return { apiToken, domain };
  }
  
  const token = match[1];
  console.error(`[DEBUG] Extracted token from Bearer: ${token.substring(0, 30)}...`);
  
  // Parse as "token:domain" format (plain text only)
  if (token.includes(':')) {
    const parts = token.split(':');
    if (parts.length >= 2) {
      apiToken = parts[0];
      domain = parts.slice(1).join(':'); // Handle domains with colons (unlikely but safe)
      console.error(`[DEBUG] Parsed credentials - token: ${apiToken ? apiToken.substring(0, 8) + '...' : 'none'}, domain: ${domain || 'none'}`);
    } else {
      console.error('[DEBUG] Token contains colon but could not parse into token:domain format');
    }
  } else {
    console.error('[DEBUG] Token does not contain colon separator (token:domain format expected)');
  }
  
  return { apiToken, domain };
}

// Create MCP server
const server = new McpServer({
  name: "pipedrive-mcp-server",
  version: "1.0.2",
  capabilities: {
    resources: {},
    tools: {},
    prompts: {}
  }
});

// === TOOLS ===

// Get all users (for finding owner IDs)
server.tool(
  "get-users",
  "Get all users/owners from Pipedrive to identify owner IDs for filtering deals",
  {},
  async () => {
    try {
      console.error('[DEBUG] Tool called: get-users');
      const credentials = getCurrentSessionCredentials();
      console.error('[DEBUG] get-users: Credentials retrieved, calling Pipedrive API');
      const response = await credentials.usersApi.getUsers();
      const users = response.data?.map((user: any) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        active_flag: user.active_flag,
        role_name: user.role_name
      })) || [];

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            summary: `Found ${users.length} users in your Pipedrive account`,
            users: users
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error fetching users:", error);
      return {
        content: [{
          type: "text",
          text: `Error fetching users: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get deals with flexible filtering options
server.tool(
  "get-deals",
  "Get deals from Pipedrive with flexible filtering options including search by title, date range, owner, stage, status, and more. Use 'get-users' tool first to find owner IDs.",
  {
    searchTitle: z.string().optional().describe("Search deals by title/name (partial matches supported)"),
    daysBack: z.number().optional().describe("Number of days back to fetch deals based on last activity date (default: 365)"),
    ownerId: z.number().optional().describe("Filter deals by owner/user ID (use get-users tool to find IDs)"),
    stageId: z.number().optional().describe("Filter deals by stage ID"),
    status: z.enum(['open', 'won', 'lost', 'deleted']).optional().describe("Filter deals by status (default: open)"),
    pipelineId: z.number().optional().describe("Filter deals by pipeline ID"),
    minValue: z.number().optional().describe("Minimum deal value filter"),
    maxValue: z.number().optional().describe("Maximum deal value filter"),
    limit: z.number().optional().describe("Maximum number of deals to return (default: 500)")
  },
  async ({
    searchTitle,
    daysBack = 365,
    ownerId,
    stageId,
    status = 'open',
    pipelineId,
    minValue,
    maxValue,
    limit = 500
  }) => {
    try {
      let filteredDeals: any[] = [];

      console.error(`[DEBUG] Tool called: get-deals (searchTitle: ${searchTitle || 'none'}, daysBack: ${daysBack}, ownerId: ${ownerId || 'none'})`);
      const credentials = getCurrentSessionCredentials();
      console.error('[DEBUG] get-deals: Credentials retrieved, calling Pipedrive API');
      
      // If searching by title, use the search API first
      if (searchTitle) {
        // @ts-ignore - Bypass incorrect TypeScript definition
        const searchResponse = await credentials.dealsApi.searchDeals(searchTitle);
        filteredDeals = searchResponse.data || [];
      } else {
        // Calculate the date filter (daysBack days ago)
        const filterDate = new Date();
        filterDate.setDate(filterDate.getDate() - daysBack);
        const startDate = filterDate.toISOString().split('T')[0]; // Format as YYYY-MM-DD

        // Build API parameters (using actual Pipedrive API parameter names)
        const params: any = {
          sort: 'last_activity_date DESC',
          status: status,
          limit: limit
        };

        // Add optional filters
        if (ownerId) params.user_id = ownerId;
        if (stageId) params.stage_id = stageId;
        if (pipelineId) params.pipeline_id = pipelineId;

        // Fetch deals with filters
        // @ts-ignore - getDeals accepts parameters but types may be incomplete
        const response = await credentials.dealsApi.getDeals(params);
        filteredDeals = response.data || [];
      }

      // Apply additional client-side filtering

      // Filter by date if not searching by title
      if (!searchTitle) {
        const filterDate = new Date();
        filterDate.setDate(filterDate.getDate() - daysBack);

        filteredDeals = filteredDeals.filter((deal: any) => {
          if (!deal.last_activity_date) return false;
          const dealActivityDate = new Date(deal.last_activity_date);
          return dealActivityDate >= filterDate;
        });
      }

      // Filter by owner if specified and not already applied in API call
      if (ownerId && searchTitle) {
        filteredDeals = filteredDeals.filter((deal: any) => deal.owner_id === ownerId);
      }

      // Filter by status if specified and searching by title
      if (status && searchTitle) {
        filteredDeals = filteredDeals.filter((deal: any) => deal.status === status);
      }

      // Filter by stage if specified and not already applied in API call
      if (stageId && (searchTitle || !stageId)) {
        filteredDeals = filteredDeals.filter((deal: any) => deal.stage_id === stageId);
      }

      // Filter by pipeline if specified and not already applied in API call
      if (pipelineId && (searchTitle || !pipelineId)) {
        filteredDeals = filteredDeals.filter((deal: any) => deal.pipeline_id === pipelineId);
      }

      // Filter by value range if specified
      if (minValue !== undefined || maxValue !== undefined) {
        filteredDeals = filteredDeals.filter((deal: any) => {
          const value = parseFloat(deal.value) || 0;
          if (minValue !== undefined && value < minValue) return false;
          if (maxValue !== undefined && value > maxValue) return false;
          return true;
        });
      }

      // Apply limit
      if (filteredDeals.length > limit) {
        filteredDeals = filteredDeals.slice(0, limit);
      }

      // Build filter summary for response
      const filterSummary = {
        ...(searchTitle && { search_title: searchTitle }),
        ...(!searchTitle && { days_back: daysBack }),
        ...(!searchTitle && { filter_date: new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().split('T')[0] }),
        status: status,
        ...(ownerId && { owner_id: ownerId }),
        ...(stageId && { stage_id: stageId }),
        ...(pipelineId && { pipeline_id: pipelineId }),
        ...(minValue !== undefined && { min_value: minValue }),
        ...(maxValue !== undefined && { max_value: maxValue }),
        total_deals_found: filteredDeals.length,
        limit_applied: limit
      };

      // Summarize deals to avoid massive responses but include notes and booking details
      const bookingFieldKey = "8f4b27fbd9dfc70d2296f23ce76987051ad7324e";
      const summarizedDeals = filteredDeals.map((deal: any) => ({
        id: deal.id,
        title: deal.title,
        value: deal.value,
        currency: deal.currency,
        status: deal.status,
        stage_name: deal.stage?.name || 'Unknown',
        pipeline_name: deal.pipeline?.name || 'Unknown',
        owner_name: deal.owner?.name || 'Unknown',
        organization_name: deal.org?.name || null,
        person_name: deal.person?.name || null,
        add_time: deal.add_time,
        last_activity_date: deal.last_activity_date,
        close_time: deal.close_time,
        won_time: deal.won_time,
        lost_time: deal.lost_time,
        notes_count: deal.notes_count || 0,
        // Include recent notes if available
        notes: deal.notes || [],
        // Include custom booking details field
        booking_details: deal[bookingFieldKey] || null
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            summary: searchTitle
              ? `Found ${filteredDeals.length} deals matching title search "${searchTitle}"`
              : `Found ${filteredDeals.length} deals matching the specified filters`,
            filters_applied: filterSummary,
            total_found: filteredDeals.length,
            deals: summarizedDeals.slice(0, 30) // Limit to 30 deals max to prevent huge responses
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error fetching deals:", error);
      return {
        content: [{
          type: "text",
          text: `Error fetching deals: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get deal by ID
server.tool(
  "get-deal",
  "Get a specific deal by ID including custom fields",
  {
    dealId: z.number().describe("Pipedrive deal ID")
  },
  async ({ dealId }) => {
    try {
      const credentials = getCurrentSessionCredentials();
      // @ts-ignore - Bypass incorrect TypeScript definition, API expects just the ID
      const response = await credentials.dealsApi.getDeal(dealId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error fetching deal ${dealId}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error fetching deal ${dealId}: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get deal notes and custom booking details
server.tool(
  "get-deal-notes",
  "Get detailed notes and custom booking details for a specific deal",
  {
    dealId: z.number().describe("Pipedrive deal ID"),
    limit: z.number().optional().describe("Maximum number of notes to return (default: 20)")
  },
  async ({ dealId, limit = 20 }) => {
    try {
      const result: any = {
        deal_id: dealId,
        notes: [],
        booking_details: null
      };

      const credentials = getCurrentSessionCredentials();
      
      // Get deal details including custom fields
      try {
        // @ts-ignore - Bypass incorrect TypeScript definition
        const dealResponse = await credentials.dealsApi.getDeal(dealId);
        const deal = dealResponse.data;

        // Extract custom booking field
        const bookingFieldKey = "8f4b27fbd9dfc70d2296f23ce76987051ad7324e";
        if (deal && deal[bookingFieldKey]) {
          result.booking_details = deal[bookingFieldKey];
        }
      } catch (dealError) {
        console.error(`Error fetching deal details for ${dealId}:`, dealError);
        result.deal_error = getErrorMessage(dealError);
      }

      // Get deal notes
      try {
        // @ts-ignore - API parameters may not be fully typed
        // @ts-ignore - Bypass incorrect TypeScript definition
        const notesResponse = await credentials.notesApi.getNotes({
          deal_id: dealId,
          limit: limit
        });
        result.notes = notesResponse.data || [];
      } catch (noteError) {
        console.error(`Error fetching notes for deal ${dealId}:`, noteError);
        result.notes_error = getErrorMessage(noteError);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            summary: `Retrieved ${result.notes.length} notes and booking details for deal ${dealId}`,
            ...result
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error fetching deal notes ${dealId}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error fetching deal notes ${dealId}: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Search deals
server.tool(
  "search-deals",
  "Search deals by term",
  {
    term: z.string().describe("Search term for deals")
  },
  async ({ term }) => {
    try {
      const credentials = getCurrentSessionCredentials();
      // @ts-ignore - Bypass incorrect TypeScript definition
      const response = await credentials.dealsApi.searchDeals(term);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error searching deals with term "${term}":`, error);
      return {
        content: [{
          type: "text",
          text: `Error searching deals: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get all persons
server.tool(
  "get-persons",
  "Get all persons from Pipedrive including custom fields",
  {},
  async () => {
    try {
      const credentials = getCurrentSessionCredentials();
      const response = await credentials.personsApi.getPersons();
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error fetching persons:", error);
      return {
        content: [{
          type: "text",
          text: `Error fetching persons: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get person by ID
server.tool(
  "get-person",
  "Get a specific person by ID including custom fields",
  {
    personId: z.number().describe("Pipedrive person ID")
  },
  async ({ personId }) => {
    try {
      const credentials = getCurrentSessionCredentials();
      // @ts-ignore - Bypass incorrect TypeScript definition
      const response = await credentials.personsApi.getPerson(personId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error fetching person ${personId}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error fetching person ${personId}: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Search persons
server.tool(
  "search-persons",
  "Search persons by term",
  {
    term: z.string().describe("Search term for persons")
  },
  async ({ term }) => {
    try {
      const credentials = getCurrentSessionCredentials();
      // @ts-ignore - Bypass incorrect TypeScript definition
      const response = await credentials.personsApi.searchPersons(term);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error searching persons with term "${term}":`, error);
      return {
        content: [{
          type: "text",
          text: `Error searching persons: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get all organizations
server.tool(
  "get-organizations",
  "Get all organizations from Pipedrive including custom fields",
  {},
  async () => {
    try {
      const credentials = getCurrentSessionCredentials();
      const response = await credentials.organizationsApi.getOrganizations();
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error fetching organizations:", error);
      return {
        content: [{
          type: "text",
          text: `Error fetching organizations: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get organization by ID
server.tool(
  "get-organization",
  "Get a specific organization by ID including custom fields",
  {
    organizationId: z.number().describe("Pipedrive organization ID")
  },
  async ({ organizationId }) => {
    try {
      const credentials = getCurrentSessionCredentials();
      // @ts-ignore - Bypass incorrect TypeScript definition
      const response = await credentials.organizationsApi.getOrganization(organizationId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error fetching organization ${organizationId}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error fetching organization ${organizationId}: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Search organizations
server.tool(
  "search-organizations",
  "Search organizations by term",
  {
    term: z.string().describe("Search term for organizations")
  },
  async ({ term }) => {
    try {
      const credentials = getCurrentSessionCredentials();
      // @ts-ignore - API method exists but TypeScript definition is wrong
      const response = await (credentials.organizationsApi as any).searchOrganization({ term });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error searching organizations with term "${term}":`, error);
      return {
        content: [{
          type: "text",
          text: `Error searching organizations: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get all pipelines
server.tool(
  "get-pipelines",
  "Get all pipelines from Pipedrive",
  {},
  async () => {
    try {
      const credentials = getCurrentSessionCredentials();
      const response = await credentials.pipelinesApi.getPipelines();
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error fetching pipelines:", error);
      return {
        content: [{
          type: "text",
          text: `Error fetching pipelines: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get pipeline by ID
server.tool(
  "get-pipeline",
  "Get a specific pipeline by ID",
  {
    pipelineId: z.number().describe("Pipedrive pipeline ID")
  },
  async ({ pipelineId }) => {
    try {
      const credentials = getCurrentSessionCredentials();
      // @ts-ignore - Bypass incorrect TypeScript definition
      const response = await credentials.pipelinesApi.getPipeline(pipelineId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error fetching pipeline ${pipelineId}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error fetching pipeline ${pipelineId}: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get all stages
server.tool(
  "get-stages",
  "Get all stages from Pipedrive",
  {},
  async () => {
    try {
      const credentials = getCurrentSessionCredentials();
      // Since the stages are related to pipelines, we'll get all pipelines first
      const pipelinesResponse = await credentials.pipelinesApi.getPipelines();
      const pipelines = pipelinesResponse.data || [];
      
      // For each pipeline, fetch its stages
      const allStages = [];
      for (const pipeline of pipelines) {
        try {
          // @ts-ignore - Type definitions for getPipelineStages are incomplete
          const stagesResponse = await credentials.pipelinesApi.getPipelineStages(pipeline.id);
          const stagesData = Array.isArray(stagesResponse?.data)
            ? stagesResponse.data
            : [];

          if (stagesData.length > 0) {
            const pipelineStages = stagesData.map((stage: any) => ({
              ...stage,
              pipeline_name: pipeline.name
            }));
            allStages.push(...pipelineStages);
          }
        } catch (e) {
          console.error(`Error fetching stages for pipeline ${pipeline.id}:`, e);
        }
      }
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(allStages, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error fetching stages:", error);
      return {
        content: [{
          type: "text",
          text: `Error fetching stages: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Search leads
server.tool(
  "search-leads",
  "Search leads by term",
  {
    term: z.string().describe("Search term for leads")
  },
  async ({ term }) => {
    try {
      const credentials = getCurrentSessionCredentials();
      // @ts-ignore - Bypass incorrect TypeScript definition
      const response = await credentials.leadsApi.searchLeads(term);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error searching leads with term "${term}":`, error);
      return {
        content: [{
          type: "text",
          text: `Error searching leads: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Generic search across item types
server.tool(
  "search-all",
  "Search across all item types (deals, persons, organizations, etc.)",
  {
    term: z.string().describe("Search term"),
    itemTypes: z.string().optional().describe("Comma-separated list of item types to search (deal,person,organization,product,file,activity,lead)")
  },
  async ({ term, itemTypes }) => {
    try {
      const credentials = getCurrentSessionCredentials();
      const itemType = itemTypes; // Just rename the parameter
      const response = await credentials.itemSearchApi.searchItem({ 
        term,
        itemType 
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error performing search with term "${term}":`, error);
      return {
        content: [{
          type: "text",
          text: `Error performing search: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// === PROMPTS ===

// Prompt for getting all deals
server.prompt(
  "list-all-deals",
  "List all deals in Pipedrive",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please list all deals in my Pipedrive account, showing their title, value, status, and stage."
      }
    }]
  })
);

// Prompt for getting all persons
server.prompt(
  "list-all-persons",
  "List all persons in Pipedrive",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please list all persons in my Pipedrive account, showing their name, email, phone, and organization."
      }
    }]
  })
);

// Prompt for getting all pipelines
server.prompt(
  "list-all-pipelines",
  "List all pipelines in Pipedrive",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please list all pipelines in my Pipedrive account, showing their name and stages."
      }
    }]
  })
);

// Prompt for analyzing deals
server.prompt(
  "analyze-deals",
  "Analyze deals by stage",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please analyze the deals in my Pipedrive account, grouping them by stage and providing total value for each stage."
      }
    }]
  })
);

// Prompt for analyzing contacts
server.prompt(
  "analyze-contacts",
  "Analyze contacts by organization",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please analyze the persons in my Pipedrive account, grouping them by organization and providing a count for each organization."
      }
    }]
  })
);

// Prompt for analyzing leads
server.prompt(
  "analyze-leads",
  "Analyze leads by status",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please search for all leads in my Pipedrive account and group them by status."
      }
    }]
  })
);

// Prompt for pipeline comparison
server.prompt(
  "compare-pipelines",
  "Compare different pipelines and their stages",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please list all pipelines in my Pipedrive account and compare them by showing the stages in each pipeline."
      }
    }]
  })
);

// Prompt for finding high-value deals
server.prompt(
  "find-high-value-deals",
  "Find high-value deals",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please identify the highest value deals in my Pipedrive account and provide information about which stage they're in and which person or organization they're associated with."
      }
    }]
  })
);

// Get transport type from environment variable (default to stdio)
// Store globally so getCurrentSessionCredentials can access it
// Options: 'stdio', 'sse', 'http'
const transportType = process.env.MCP_TRANSPORT || 'stdio';

if (transportType === 'sse' || transportType === 'http') {
  // SSE transport - create HTTP server
  // Railway provides PORT environment variable, fallback to MCP_PORT or 3000
  const port = parseInt(process.env.PORT || process.env.MCP_PORT || '3000', 10);
  const endpoint = process.env.MCP_ENDPOINT || '/message';

  // Store active transports by session ID
  // For SSE mode: SSEServerTransport
  // For HTTP mode: Simple HTTP transport wrapper
  const transports = new Map<string, SSEServerTransport | any>();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    // MCP-compliant: Only Authorization header is supported
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-Id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/sse') {
      // Extract credentials from request headers (MCP-compliant token:domain format)
      console.error(`[DEBUG] SSE connection request - URL: ${req.url}, method: ${req.method}`);
      const { apiToken, domain } = extractCredentialsFromRequest(req);
      
      // For SSE mode, credentials are required to establish the connection
      if (!apiToken || !domain) {
        console.error(`[DEBUG] ❌ SSE connection rejected: Missing credentials`);
        console.error(`[DEBUG] Available headers: ${JSON.stringify(Object.keys(req.headers))}`);
        // Try to help debug - show if Authorization header exists
        if (req.headers['authorization']) {
          const authValue = Array.isArray(req.headers['authorization']) 
            ? req.headers['authorization'][0] 
            : req.headers['authorization'];
          console.error(`[DEBUG] Authorization header exists but wasn't parsed. Value: ${authValue.substring(0, 50)}...`);
        }
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          error: 'Missing credentials. MCP-compliant authentication requires Authorization: Bearer token:domain header.' 
        }));
        return;
      }
      
      // Establish SSE connection
      const transport = new SSEServerTransport(endpoint, res);
      console.error(`[DEBUG] SSE transport created - sessionId: ${transport.sessionId}`);

      // Store credentials for this session
      try {
        getSessionCredentials(transport.sessionId, apiToken, domain);
        console.error(`[DEBUG] ✅ Credentials stored for SSE session: ${transport.sessionId} (domain: ${domain})`);
      } catch (err) {
        console.error(`[DEBUG] ❌ Failed to store credentials for session ${transport.sessionId}:`, err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to initialize credentials' }));
        return;
      }

      // Store transport by session ID
      transports.set(transport.sessionId, transport);

      transport.onclose = () => {
        console.error(`[DEBUG] SSE connection closed: ${transport.sessionId}`);
        transports.delete(transport.sessionId);
        sessions.delete(transport.sessionId);
        console.error(`[DEBUG] Cleaned up session ${transport.sessionId}. Remaining sessions: ${sessions.size}`);
      };

      try {
        // Wrap server connection in session context
        console.error(`[DEBUG] Connecting server to SSE transport for session ${transport.sessionId}`);
        await sessionContext.run(transport.sessionId, async () => {
          await server.connect(transport);
        });
        console.error(`[DEBUG] ✅ SSE connection established: ${transport.sessionId}`);
      } catch (err) {
        console.error(`[DEBUG] ❌ Failed to establish SSE connection for session ${transport.sessionId}:`, err);
        transports.delete(transport.sessionId);
        sessions.delete(transport.sessionId);
      }
    } else if (req.method === 'POST' && url.pathname === endpoint) {
      const authResult = verifyRequestAuthentication(req);
      if (!authResult.ok) {
        res.writeHead(authResult.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: authResult.message }));
        return;
      }

      // Extract credentials from request headers (required for HTTP mode, optional for SSE)
      console.error(`[DEBUG] POST request to ${endpoint} - URL: ${req.url}`);
      const { apiToken, domain } = extractCredentialsFromRequest(req);
      
      // Handle incoming message
      const sessionId = url.searchParams.get('sessionId') || req.headers['x-session-id'] as string;
      console.error(`[DEBUG] POST request - sessionId: ${sessionId || 'none'}, hasCredentials: ${!!(apiToken && domain)}`);

      // For HTTP mode: credentials are required in every request, sessionId is optional
      if (transportType === 'http') {
        console.error('[DEBUG] Processing HTTP mode request');
        if (!apiToken || !domain) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            error: 'Missing credentials. MCP-compliant authentication requires Authorization: Bearer token:domain header.' 
          }));
          return;
        }
        
        // Create or get session ID for HTTP mode
        const httpSessionId = sessionId || `http-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        
        // Store credentials for this session
        try {
          getSessionCredentials(httpSessionId, apiToken, domain);
        } catch (err) {
          console.error('Failed to store credentials:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to initialize credentials' }));
          return;
        }
        
        // For HTTP mode, we need to handle the message without SSE transport
        // Read the request body and process it
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        
        req.on('end', async () => {
          try {
            await sessionContext.run(httpSessionId, async () => {
              // Parse the MCP JSON-RPC message
              let message: any;
              try {
                message = JSON.parse(body);
                console.error(`[DEBUG] Parsed MCP message: ${message.method || 'response'} (id: ${message.id || 'none'})`);
              } catch (parseErr) {
                console.error('[DEBUG] Failed to parse JSON body:', parseErr);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                  jsonrpc: '2.0',
                  id: null,
                  error: { code: -32700, message: 'Parse error' }
                }));
                return;
              }
              
              // For HTTP mode, we need to handle messages directly
              // Create a simple transport that can send responses back
              let transport = transports.get(httpSessionId) as any;
              
              if (!transport) {
                // Create a simple HTTP transport wrapper that implements the Transport interface
                const httpTransport = {
                  sessionId: httpSessionId,
                  _currentResponse: null as http.ServerResponse | null,
                  
                  async start() {
                    // No-op for HTTP mode
                    console.error(`[DEBUG] HTTP transport started for session ${httpSessionId}`);
                  },
                  
                  async send(response: any) {
                    console.error(`[DEBUG] HTTP transport sending response for message ${response.id || 'notification'}`);
                    // Send response immediately if we have the response object
                    if (this._currentResponse && !this._currentResponse.headersSent) {
                      this._currentResponse.writeHead(200, { 'Content-Type': 'application/json' });
                      this._currentResponse.end(JSON.stringify(response));
                    } else {
                      console.error('[DEBUG] Warning: Cannot send response - response object not available or headers already sent');
                    }
                  },
                  
                  async close() {
                    // No-op for HTTP mode
                  },
                  
                  onclose: undefined,
                  onerror: undefined,
                  onmessage: undefined
                };
                
                transports.set(httpSessionId, httpTransport);
                transport = httpTransport;
                
                // Connect server to this transport
                try {
                  await server.connect(httpTransport as any);
                  console.error(`[DEBUG] Server connected to HTTP transport for session ${httpSessionId}`);
                } catch (err) {
                  console.error(`[DEBUG] Error connecting server to transport:`, err);
                  // If already connected, that's fine
                  if (err && (err as Error).message?.includes('already connected')) {
                    // Continue
                  } else {
                    throw err;
                  }
                }
              }
              
              // Store the response object for this request so transport.send() can use it
              transport._currentResponse = res;
              
              // Handle the message through the transport's onmessage callback
              // The server sets this up when we call connect()
              if (transport.onmessage) {
                console.error(`[DEBUG] Calling transport.onmessage for ${message.method || 'response'}`);
                
                // Process the message - responses will be sent via transport.send()
                try {
                  transport.onmessage(message);
                  
                  // For requests (with id), wait a bit for the response
                  // For notifications (no id), we can send accepted immediately
                  if (message.id !== undefined) {
                    // Wait for response (with timeout)
                    await new Promise<void>((resolve) => {
                      const checkInterval = setInterval(() => {
                        if (res.headersSent) {
                          clearInterval(checkInterval);
                          resolve();
                        }
                      }, 10);
                      
                      // Timeout after 5 seconds
                      setTimeout(() => {
                        clearInterval(checkInterval);
                        if (!res.headersSent) {
                          console.error('[DEBUG] Timeout waiting for response, sending 202 Accepted');
                          res.writeHead(202, { 'Content-Type': 'application/json' });
                          res.end('Accepted');
                        }
                        resolve();
                      }, 5000);
                    });
                  } else {
                    // Notification - send accepted immediately
                    if (!res.headersSent) {
                      res.writeHead(202, { 'Content-Type': 'application/json' });
                      res.end('Accepted');
                    }
                  }
                } catch (msgErr) {
                  console.error('[DEBUG] Error processing message:', msgErr);
                  if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                      jsonrpc: '2.0',
                      id: message.id || null,
                      error: { 
                        code: -32603, 
                        message: 'Internal error',
                        data: msgErr instanceof Error ? msgErr.message : String(msgErr)
                      }
                    }));
                  }
                }
              } else {
                console.error('[DEBUG] Transport does not have onmessage handler');
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                  jsonrpc: '2.0',
                  id: message.id || null,
                  error: { code: -32603, message: 'Internal error: Transport not properly initialized' }
                }));
              }
            });
          } catch (err) {
            console.error('[DEBUG] Error handling HTTP message:', err);
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ 
                jsonrpc: '2.0',
                id: null,
                error: {
                  code: -32603,
                  message: 'Internal error',
                  data: err instanceof Error ? err.message : String(err)
                }
              }));
            }
          }
        });
        
        return; // Exit early for HTTP mode
      }
      
      // SSE mode: require sessionId
      if (!sessionId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing sessionId for SSE mode' }));
        return;
      }

      // Extract and update credentials if provided in this request
      if (apiToken && domain) {
        try {
          getSessionCredentials(sessionId, apiToken, domain);
          console.error(`Credentials updated for session: ${sessionId}`);
        } catch (err) {
          console.error('Failed to update credentials:', err);
        }
      } else {
        // If no credentials in this request, check if session already has credentials
        if (!sessions.has(sessionId)) {
          console.error(`Warning: No credentials found for session ${sessionId} in POST request`);
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No credentials found for this session' }));
          return;
        }
      }

      const transport = transports.get(sessionId);
      if (!transport) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found. Establish SSE connection first at /sse' }));
        return;
      }

      req.on('error', err => {
        console.error('Error receiving POST message body:', err);
        if (!res.headersSent) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid request body' }));
        }
      });

      try {
        // Ensure credentials exist for this session before handling messages
        if (!sessions.has(sessionId)) {
          // Try to get credentials from this request
          const { apiToken, domain } = extractCredentialsFromRequest(req);
          if (apiToken && domain) {
            getSessionCredentials(sessionId, apiToken, domain);
            console.error(`Credentials loaded from POST request for session: ${sessionId}`);
          } else {
            console.error(`Error: No credentials found for session ${sessionId} and none provided in POST request`);
            if (!res.headersSent) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'No credentials found for this session. Provide Authorization: Bearer token:domain header.' }));
            }
            return;
          }
        }
        
        // Wrap message handling in session context
        // This ensures tool calls can access the session ID via AsyncLocalStorage
        await sessionContext.run(sessionId, async () => {
          await transport.handlePostMessage(req, res);
        });
      } catch (err) {
        console.error('Error handling POST message:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      }
    } else {
      // Health check endpoint
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', transport: transportType }));
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    }
  });

  httpServer.listen(port, () => {
    console.error(`Pipedrive MCP Server (${transportType.toUpperCase()}) listening on port ${port}`);
    if (transportType === 'sse') {
      console.error(`SSE endpoint: http://localhost:${port}/sse`);
    }
    console.error(`Message endpoint: http://localhost:${port}${endpoint}`);
    if (transportType === 'http') {
      console.error(`HTTP mode: POST directly to ${endpoint} with credentials in headers`);
    }
  });
} else {
  // Default: stdio transport
  // For stdio, initialize default credentials if available
  if (defaultApiToken && defaultDomain) {
    try {
      getSessionCredentials('stdio', defaultApiToken, defaultDomain);
      console.error("Default credentials initialized for stdio transport");
    } catch (err) {
      console.error("Failed to initialize default credentials:", err);
    }
  } else {
    console.error("Warning: No default credentials found. Tools will fail unless credentials are provided via other means.");
  }

  const transport = new StdioServerTransport();
  
  // Wrap server connection in session context for stdio
  sessionContext.run('stdio', async () => {
    await server.connect(transport);
  }).catch(err => {
    console.error("Failed to start MCP server:", err);
    process.exit(1);
  });

  console.error("Pipedrive MCP Server started (stdio transport)");
}
