#!/bin/bash

# Test script for Pipedrive MCP Server
# This script starts the server, runs tests, and shuts it down

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
PORT=${PORT:-3000}
ENDPOINT="/message"
SSE_ENDPOINT="/sse"
HEALTH_ENDPOINT="/health"
BASE_URL="http://localhost:${PORT}"

# Test credentials (replace with your actual credentials for real testing)
TEST_API_TOKEN="${TEST_API_TOKEN:-test-token-12345}"
TEST_DOMAIN="${TEST_DOMAIN:-testcompany.pipedrive.com}"
AUTH_HEADER="Bearer ${TEST_API_TOKEN}:${TEST_DOMAIN}"

# Server process ID
SERVER_PID=""
# SSE connection PID (for keeping connection alive)
SSE_CONNECTION_PID=""
SSE_SESSION_ID=""
SSE_RESPONSE_FILE=""

# Cleanup function
cleanup() {
    echo -e "\n${YELLOW}Cleaning up...${NC}"
    
    # Close SSE connection if it's still running
    if [ ! -z "$SSE_CONNECTION_PID" ] && kill -0 $SSE_CONNECTION_PID 2>/dev/null; then
        echo "Closing SSE connection (PID: $SSE_CONNECTION_PID)..."
        kill $SSE_CONNECTION_PID 2>/dev/null || true
        wait $SSE_CONNECTION_PID 2>/dev/null || true
    fi
    
    # Clean up SSE response file
    if [ ! -z "$SSE_RESPONSE_FILE" ] && [ -f "$SSE_RESPONSE_FILE" ]; then
        rm -f "$SSE_RESPONSE_FILE"
    fi
    
    if [ ! -z "$SERVER_PID" ]; then
        echo "Stopping server (PID: $SERVER_PID)..."
        kill $SERVER_PID 2>/dev/null || true
        wait $SERVER_PID 2>/dev/null || true
        echo -e "${GREEN}Server stopped${NC}"
    fi
}

# Set trap to cleanup on exit
trap cleanup EXIT INT TERM

# Function to check if server is ready
wait_for_server() {
    echo -e "${YELLOW}Waiting for server to start...${NC}"
    local max_attempts=30
    local attempt=0
    
    while [ $attempt -lt $max_attempts ]; do
        if curl -s -f "${BASE_URL}${HEALTH_ENDPOINT}" > /dev/null 2>&1; then
            echo -e "${GREEN}✓ Server is ready!${NC}"
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 1
    done
    
    echo -e "${RED}✗ Server failed to start within ${max_attempts} seconds${NC}"
    return 1
}

# Function to format JSON output
format_json() {
    local json="$1"
    if command -v jq > /dev/null 2>&1; then
        echo "$json" | jq '.' 2>/dev/null || echo "$json"
    else
        echo "$json"
    fi
}

# Function to run a test
run_test() {
    local test_name="$1"
    local url="$2"
    local method="${3:-GET}"
    local headers="${4:-}"
    local data="${5:-}"
    local expected_status="${6:-200}"
    
    echo -e "\n${YELLOW}Test: ${test_name}${NC}"
    
    local curl_cmd="curl -s -w '\nHTTP_CODE:%{http_code}' -X ${method}"
    
    if [ ! -z "$headers" ]; then
        curl_cmd="${curl_cmd} ${headers}"
    fi
    
    if [ ! -z "$data" ]; then
        curl_cmd="${curl_cmd} -d '${data}'"
    fi
    
    curl_cmd="${curl_cmd} '${url}'"
    
    local response=$(eval $curl_cmd)
    local http_code=$(echo "$response" | grep "HTTP_CODE" | cut -d: -f2)
    local body=$(echo "$response" | sed '/HTTP_CODE/d')
    
    if [ "$http_code" = "$expected_status" ]; then
        echo -e "${GREEN}✓ Passed (HTTP ${http_code})${NC}"
        if [ ! -z "$body" ] && [ "$body" != "null" ]; then
            echo -e "${YELLOW}Response:${NC}"
            format_json "$body" | head -n 50
            if [ $(echo "$body" | wc -l) -gt 50 ] || [ ${#body} -gt 2000 ]; then
                echo -e "${YELLOW}... (truncated)${NC}"
            fi
        fi
        return 0
    else
        echo -e "${RED}✗ Failed (Expected HTTP ${expected_status}, got ${http_code})${NC}"
        echo -e "${YELLOW}Response:${NC}"
        format_json "$body"
        return 1
    fi
}

# Function to establish SSE connection and get session ID
# This keeps the SSE connection alive in the background and captures responses
# Sets global variables: SSE_SESSION_ID, SSE_CONNECTION_PID, SSE_RESPONSE_FILE
establish_sse_connection() {
    # Create a file to capture all SSE events (set as global variable, not local)
    SSE_RESPONSE_FILE=$(mktemp)
    
    # Start curl in background to keep SSE connection alive
    # We'll read from it to get the session ID and responses
    curl -s -N -H 'Accept: text/event-stream' -H "Authorization: ${AUTH_HEADER}" "${BASE_URL}${SSE_ENDPOINT}" >> "$SSE_RESPONSE_FILE" 2>&1 &
    local curl_pid=$!
    SSE_CONNECTION_PID=$curl_pid
    
    # Wait a bit for the initial SSE events
    sleep 2
    
    # Verify the file exists and has content
    if [ ! -f "$SSE_RESPONSE_FILE" ]; then
        echo "Error: SSE response file was not created" >&2
        kill $curl_pid 2>/dev/null || true
        SSE_CONNECTION_PID=""
        SSE_RESPONSE_FILE=""
        return 1
    fi
    
    # Read the response to extract session ID
    local response=$(cat "$SSE_RESPONSE_FILE" 2>/dev/null | head -n 20)
    
    # Debug: show what we got
    if [ -z "$response" ]; then
        echo "Error: No response from SSE endpoint" >&2
        if [ ! -z "$SSE_CONNECTION_PID" ]; then
            kill $SSE_CONNECTION_PID 2>/dev/null || true
        fi
        SSE_CONNECTION_PID=""
        if [ ! -z "$SSE_RESPONSE_FILE" ] && [ -f "$SSE_RESPONSE_FILE" ]; then
            rm -f "$SSE_RESPONSE_FILE"
        fi
        SSE_RESPONSE_FILE=""
        return 1
    fi
    
    # Extract sessionId from SSE response
    # Format: event: endpoint\n data: /message?sessionId=UUID
    local session_id=$(echo "$response" | grep -A 1 "event: endpoint" | grep "data:" | grep -o "sessionId=[^ ]*" | cut -d= -f2 | head -n 1)
    
    # Alternative: try to extract from any data line containing sessionId
    if [ -z "$session_id" ]; then
        session_id=$(echo "$response" | grep "data:" | grep -o "sessionId=[^ ]*" | cut -d= -f2 | head -n 1)
    fi
    
    # Another alternative: extract UUID from URL pattern
    if [ -z "$session_id" ]; then
        session_id=$(echo "$response" | grep -oE "sessionId=[a-f0-9-]{36}" | cut -d= -f2 | head -n 1)
    fi
    
    # One more try: extract from the full data line using sed
    if [ -z "$session_id" ]; then
        local data_line=$(echo "$response" | grep "data:" | head -n 1)
        if [ ! -z "$data_line" ]; then
            # Extract sessionId=value from the data line
            session_id=$(echo "$data_line" | sed -E 's/.*sessionId=([a-f0-9-]+).*/\1/' | head -n 1)
        fi
    fi
    
    if [ -z "$session_id" ]; then
        echo "Error: Could not extract session ID from SSE response" >&2
        echo "Raw response (first 500 chars):" >&2
        echo "$response" | head -c 500 >&2
        echo "" >&2
        if [ ! -z "$SSE_CONNECTION_PID" ]; then
            kill $SSE_CONNECTION_PID 2>/dev/null || true
        fi
        SSE_CONNECTION_PID=""
        if [ ! -z "$SSE_RESPONSE_FILE" ] && [ -f "$SSE_RESPONSE_FILE" ]; then
            rm -f "$SSE_RESPONSE_FILE"
        fi
        SSE_RESPONSE_FILE=""
        SSE_SESSION_ID=""
        return 1
    fi
    
    # Verify the connection is still alive
    if [ -z "$SSE_CONNECTION_PID" ] || ! kill -0 $SSE_CONNECTION_PID 2>/dev/null; then
        echo "Error: SSE connection died unexpectedly" >&2
        SSE_CONNECTION_PID=""
        if [ ! -z "$SSE_RESPONSE_FILE" ] && [ -f "$SSE_RESPONSE_FILE" ]; then
            rm -f "$SSE_RESPONSE_FILE"
        fi
        SSE_RESPONSE_FILE=""
        SSE_SESSION_ID=""
        return 1
    fi
    
    # Set global variable and return success
    SSE_SESSION_ID="$session_id"
    return 0
}

# Function to send MCP JSON-RPC message via SSE and get response
send_mcp_message_sse() {
    local session_id="$1"
    local method="$2"
    local params="$3"
    local message_id="${4:-$(date +%s)}"
    
    # Check if SSE response file exists
    if [ -z "$SSE_RESPONSE_FILE" ] || [ ! -f "$SSE_RESPONSE_FILE" ]; then
        echo "Error: SSE response file not found. SSE connection may not be established." >&2
        return 1
    fi
    
    local jsonrpc_message="{\"jsonrpc\":\"2.0\",\"id\":${message_id},\"method\":\"${method}\",\"params\":${params}}"
    
    # Get current line count in SSE response file to know where to start reading
    local start_line=$(wc -l < "$SSE_RESPONSE_FILE" 2>/dev/null || echo "0")
    
    # Send the POST request
    local post_response=$(curl -s -w '\nHTTP_CODE:%{http_code}' -X POST \
        -H 'Content-Type: application/json' \
        -H "Authorization: ${AUTH_HEADER}" \
        -d "${jsonrpc_message}" \
        "${BASE_URL}${ENDPOINT}?sessionId=${session_id}")
    
    local http_code=$(echo "$post_response" | grep "HTTP_CODE" | cut -d: -f2)
    local post_body=$(echo "$post_response" | sed '/HTTP_CODE/d')
    
    # Check if POST was accepted
    if [ "$http_code" != "200" ] && [ "$http_code" != "202" ]; then
        echo "Error: HTTP $http_code - $post_body" >&2
        return 1
    fi
    
    # Wait for response to appear in SSE stream (up to 10 seconds)
    local max_wait=10
    local waited=0
    local response_found=""
    
    while [ $waited -lt $max_wait ]; do
        sleep 0.5
        waited=$((waited + 1))
        
        # Read new lines from SSE response file
        local new_lines=$(tail -n +$((start_line + 1)) "$SSE_RESPONSE_FILE" 2>/dev/null)
        
        if [ ! -z "$new_lines" ]; then
            # Look for JSON-RPC response with matching ID
            # SSE format: data: {"jsonrpc":"2.0","id":123,...}
            local response=$(echo "$new_lines" | grep -A 1 "data:" | grep "\"id\":${message_id}" | head -n 1 | sed 's/^data: //')
            
            if [ ! -z "$response" ]; then
                echo "$response"
                return 0
            fi
            
            # Also check if there's a complete JSON object in the data lines
            local json_response=$(echo "$new_lines" | awk '/^data: / {sub(/^data: /, ""); print}' | jq -c "select(.id == ${message_id})" 2>/dev/null | head -n 1)
            if [ ! -z "$json_response" ]; then
                echo "$json_response"
                return 0
            fi
        fi
    done
    
    # If we didn't find a response, try to extract any JSON from the new lines
    local new_lines=$(tail -n +$((start_line + 1)) "$SSE_RESPONSE_FILE" 2>/dev/null)
    if [ ! -z "$new_lines" ]; then
        # Try to extract JSON from data lines
        local json_data=$(echo "$new_lines" | awk '/^data: / {sub(/^data: /, ""); print}' | tail -n 1)
        if [ ! -z "$json_data" ]; then
            echo "$json_data"
            return 0
        fi
    fi
    
    # Return the POST response body as fallback
    if [ ! -z "$post_body" ]; then
        echo "$post_body"
        return 0
    fi
    
    echo "Error: No response received from SSE stream" >&2
    return 1
}

# Function to test MCP tool call via SSE
test_tool_call_sse() {
    local session_id="$1"
    local test_name="$2"
    local tool_name="$3"
    local tool_params="$4"
    
    echo -e "\n${YELLOW}Test: ${test_name}${NC}"
    
    local response=$(send_mcp_message_sse "$session_id" "tools/call" "{\"name\":\"${tool_name}\",\"arguments\":${tool_params}}")
    
    if [ $? -eq 0 ]; then
        # Check if response has error
        if echo "$response" | grep -q '"error"'; then
            echo -e "${RED}✗ Failed: Tool returned error${NC}"
            echo -e "${YELLOW}Response:${NC}"
            format_json "$response"
            return 1
        fi
        
        # Check if response has result
        if echo "$response" | grep -q '"result"'; then
            echo -e "${GREEN}✓ Passed${NC}"
            echo -e "${YELLOW}Response:${NC}"
            format_json "$response" | head -n 100
            if [ $(echo "$response" | wc -l) -gt 100 ] || [ ${#response} -gt 5000 ]; then
                echo -e "${YELLOW}... (truncated)${NC}"
            fi
            
            # Try to extract and show some useful info
            if command -v jq > /dev/null 2>&1; then
                local content_type=$(echo "$response" | jq -r '.result.content[0].type // empty' 2>/dev/null)
                local is_error=$(echo "$response" | jq -r '.result.content[0].isError // false' 2>/dev/null)
                if [ "$is_error" = "true" ]; then
                    echo -e "${YELLOW}⚠ Warning: Response indicates error${NC}"
                fi
                if [ ! -z "$content_type" ]; then
                    echo -e "${GREEN}Content type: ${content_type}${NC}"
                fi
            fi
            return 0
        else
            echo -e "${RED}✗ Failed: No result in response${NC}"
            echo -e "${YELLOW}Response:${NC}"
            format_json "$response"
            return 1
        fi
    else
        return 1
    fi
}

# Main execution
echo -e "${GREEN}=== Pipedrive MCP Server Test Script ===${NC}\n"

# Check if server is already running
if curl -s -f "${BASE_URL}${HEALTH_ENDPOINT}" > /dev/null 2>&1; then
    echo -e "${YELLOW}Warning: Server appears to be already running on port ${PORT}${NC}"
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Build the project
echo -e "${YELLOW}Building project...${NC}"
npm run build
echo -e "${GREEN}✓ Build complete${NC}"

# Start the server
echo -e "\n${YELLOW}Starting server on port ${PORT}...${NC}"
MCP_TRANSPORT=sse MCP_PORT=${PORT} npm start > /tmp/pipedrive-mcp-server.log 2>&1 &
SERVER_PID=$!
echo "Server started with PID: $SERVER_PID"
echo "Logs: tail -f /tmp/pipedrive-mcp-server.log"

# Wait for server to be ready
if ! wait_for_server; then
    echo -e "${RED}Failed to start server. Check logs:${NC}"
    tail -20 /tmp/pipedrive-mcp-server.log
    exit 1
fi

# Run tests
echo -e "\n${GREEN}=== Running Tests ===${NC}"

FAILED_TESTS=0

# Test 1: Health check
run_test "Health Check" "${BASE_URL}${HEALTH_ENDPOINT}" "GET" "" "" "200" || FAILED_TESTS=$((FAILED_TESTS + 1))

# Test 2: SSE endpoint without credentials (should fail - credentials required)
run_test "SSE Endpoint (no credentials)" "${BASE_URL}${SSE_ENDPOINT}" "GET" "-H 'Accept: text/event-stream' --max-time 2" "" "401" || FAILED_TESTS=$((FAILED_TESTS + 1))

# Test 3: SSE endpoint with credentials
run_test "SSE Endpoint (with credentials)" "${BASE_URL}${SSE_ENDPOINT}" "GET" "-H 'Accept: text/event-stream' -H 'Authorization: ${AUTH_HEADER}' --max-time 2" "" "200" || FAILED_TESTS=$((FAILED_TESTS + 1))

# Test 4: POST to message endpoint without sessionId (should fail for SSE mode)
run_test "POST /message (no sessionId)" "${BASE_URL}${ENDPOINT}" "POST" "-H 'Content-Type: application/json' -H 'Authorization: ${AUTH_HEADER}'" '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' "400" || FAILED_TESTS=$((FAILED_TESTS + 1))

# Test 5: POST to message endpoint with invalid sessionId
run_test "POST /message (invalid sessionId)" "${BASE_URL}${ENDPOINT}?sessionId=invalid-session" "POST" "-H 'Content-Type: application/json' -H 'Authorization: ${AUTH_HEADER}'" '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' "404" || FAILED_TESTS=$((FAILED_TESTS + 1))

# Test 6: Test with malformed Authorization header
run_test "SSE Endpoint (malformed auth)" "${BASE_URL}${SSE_ENDPOINT}" "GET" "-H 'Accept: text/event-stream' -H 'Authorization: InvalidFormat' --max-time 2" "" "401" || FAILED_TESTS=$((FAILED_TESTS + 1))

# Test 7: Test with missing colon in token (token without domain)
run_test "SSE Endpoint (missing colon)" "${BASE_URL}${SSE_ENDPOINT}" "GET" "-H 'Accept: text/event-stream' -H 'Authorization: Bearer ${TEST_API_TOKEN}' --max-time 2" "" "401" || FAILED_TESTS=$((FAILED_TESTS + 1))

# Test 8: Establish SSE connection for API tests
echo -e "\n${YELLOW}Test: Establish SSE Connection${NC}"
establish_sse_connection
if [ $? -eq 0 ] && [ ! -z "$SSE_SESSION_ID" ]; then
    echo -e "${GREEN}✓ Passed${NC}"
    echo "Session ID: ${SSE_SESSION_ID}"
    if [ ! -z "$SSE_CONNECTION_PID" ]; then
        echo "SSE connection kept alive (PID: ${SSE_CONNECTION_PID})"
    else
        echo "SSE connection kept alive (PID: unknown)"
    fi
    if [ ! -z "$SSE_RESPONSE_FILE" ] && [ -f "$SSE_RESPONSE_FILE" ]; then
        echo "SSE responses being captured to: ${SSE_RESPONSE_FILE}"
    else
        echo -e "${RED}Warning: SSE response file not set or doesn't exist${NC}"
    fi
    # Give the server a moment to fully establish the connection
    sleep 1
else
    echo -e "${RED}✗ Failed to establish SSE connection${NC}"
    FAILED_TESTS=$((FAILED_TESTS + 1))
    SSE_SESSION_ID=""
    SSE_CONNECTION_PID=""
    SSE_RESPONSE_FILE=""
fi

# Test 9-13: API tool calls (only if SSE connection was established)
if [ ! -z "$SSE_SESSION_ID" ]; then
    # Test 9: List available tools
    echo -e "\n${YELLOW}Test: List Tools${NC}"
    TOOLS_RESPONSE=$(send_mcp_message_sse "$SSE_SESSION_ID" "tools/list" "{}" "100")
    if [ $? -eq 0 ] && echo "$TOOLS_RESPONSE" | grep -q '"result"'; then
        echo -e "${GREEN}✓ Passed${NC}"
        if command -v jq > /dev/null 2>&1; then
            TOOL_COUNT=$(echo "$TOOLS_RESPONSE" | jq '.result.tools | length' 2>/dev/null)
            echo -e "${GREEN}Found ${TOOL_COUNT} tool(s):${NC}"
            echo "$TOOLS_RESPONSE" | jq -r '.result.tools[] | "  - \(.name): \(.description // "No description")"' 2>/dev/null | head -n 10
        else
            TOOL_COUNT=$(echo "$TOOLS_RESPONSE" | grep -o '"name"' | wc -l | tr -d ' ')
            echo "Found ${TOOL_COUNT} tool(s)"
            echo -e "${YELLOW}Response:${NC}"
            format_json "$TOOLS_RESPONSE" | head -n 30
        fi
    else
        echo -e "${RED}✗ Failed${NC}"
        echo -e "${YELLOW}Response:${NC}"
        format_json "$TOOLS_RESPONSE"
        FAILED_TESTS=$((FAILED_TESTS + 1))
    fi
    
    # Test 10: Call get-users tool
    test_tool_call_sse "$SSE_SESSION_ID" "Call get-users tool" "get-users" "{}" || FAILED_TESTS=$((FAILED_TESTS + 1))
    
    # Test 11: Call get-pipelines tool
    test_tool_call_sse "$SSE_SESSION_ID" "Call get-pipelines tool" "get-pipelines" "{}" || FAILED_TESTS=$((FAILED_TESTS + 1))
    
    # Test 12: Call get-stages tool
    test_tool_call_sse "$SSE_SESSION_ID" "Call get-stages tool" "get-stages" "{}" || FAILED_TESTS=$((FAILED_TESTS + 1))
    
    # Test 13: Call get-deals tool (with limit)
    test_tool_call_sse "$SSE_SESSION_ID" "Call get-deals tool (limit 5)" "get-deals" "{\"limit\":5}" || FAILED_TESTS=$((FAILED_TESTS + 1))
fi

# Summary
echo -e "\n${GREEN}=== Test Summary ===${NC}"
if [ $FAILED_TESTS -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}✗ ${FAILED_TESTS} test(s) failed${NC}"
    echo -e "\n${YELLOW}Recent server logs:${NC}"
    tail -30 /tmp/pipedrive-mcp-server.log
    exit 1
fi

