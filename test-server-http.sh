#!/bin/bash

# Test script for Pipedrive MCP Server (HTTP mode)
# This script starts the server in HTTP mode, runs tests, and shuts it down

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
PORT=${PORT:-3000}
ENDPOINT="/message"
HEALTH_ENDPOINT="/health"
BASE_URL="http://localhost:${PORT}"

# Test credentials (replace with your actual credentials for real testing)
TEST_API_TOKEN="${TEST_API_TOKEN:-test-token-12345}"
TEST_DOMAIN="${TEST_DOMAIN:-testcompany.pipedrive.com}"
AUTH_HEADER="Bearer ${TEST_API_TOKEN}:${TEST_DOMAIN}"

# Server process ID
SERVER_PID=""

# Cleanup function
cleanup() {
    echo -e "\n${YELLOW}Cleaning up...${NC}"
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

# Function to send MCP JSON-RPC message and get response
send_mcp_message() {
    local method="$1"
    local params="$2"
    local message_id="${3:-$(date +%s)}"
    
    local jsonrpc_message="{\"jsonrpc\":\"2.0\",\"id\":${message_id},\"method\":\"${method}\",\"params\":${params}}"
    
    local response=$(curl -s -w '\nHTTP_CODE:%{http_code}' -X POST \
        -H 'Content-Type: application/json' \
        -H "Authorization: ${AUTH_HEADER}" \
        -d "${jsonrpc_message}" \
        "${BASE_URL}${ENDPOINT}")
    
    local http_code=$(echo "$response" | grep "HTTP_CODE" | cut -d: -f2)
    local body=$(echo "$response" | sed '/HTTP_CODE/d')
    
    if [ "$http_code" = "200" ]; then
        echo "$body"
        return 0
    else
        echo "Error: HTTP $http_code - $body" >&2
        return 1
    fi
}

# Function to test MCP tool call
test_tool_call() {
    local test_name="$1"
    local tool_name="$2"
    local tool_params="$3"
    
    echo -e "\n${YELLOW}Test: ${test_name}${NC}"
    
    local response=$(send_mcp_message "tools/call" "{\"name\":\"${tool_name}\",\"arguments\":${tool_params}}")
    
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
echo -e "${GREEN}=== Pipedrive MCP Server Test Script (HTTP Mode) ===${NC}\n"

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

# Start the server in HTTP mode
echo -e "\n${YELLOW}Starting server in HTTP mode on port ${PORT}...${NC}"
MCP_TRANSPORT=http MCP_PORT=${PORT} npm start > /tmp/pipedrive-mcp-server-http.log 2>&1 &
SERVER_PID=$!
echo "Server started with PID: $SERVER_PID"
echo "Logs: tail -f /tmp/pipedrive-mcp-server-http.log"

# Wait for server to be ready
if ! wait_for_server; then
    echo -e "${RED}Failed to start server. Check logs:${NC}"
    tail -20 /tmp/pipedrive-mcp-server-http.log
    exit 1
fi

# Run tests
echo -e "\n${GREEN}=== Running Tests ===${NC}"

FAILED_TESTS=0

# Test 1: Health check
run_test "Health Check" "${BASE_URL}${HEALTH_ENDPOINT}" "GET" "" "" "200" || FAILED_TESTS=$((FAILED_TESTS + 1))

# Test 2: POST to message endpoint without credentials (should fail)
run_test "POST /message (no credentials)" "${BASE_URL}${ENDPOINT}" "POST" "-H 'Content-Type: application/json'" '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' "401" || FAILED_TESTS=$((FAILED_TESTS + 1))

# Test 3: POST to message endpoint with credentials
run_test "POST /message (with credentials)" "${BASE_URL}${ENDPOINT}" "POST" "-H 'Content-Type: application/json' -H 'Authorization: ${AUTH_HEADER}'" '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' "200" || FAILED_TESTS=$((FAILED_TESTS + 1))

# Test 4: POST with malformed Authorization header
run_test "POST /message (malformed auth)" "${BASE_URL}${ENDPOINT}" "POST" "-H 'Content-Type: application/json' -H 'Authorization: InvalidFormat'" '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' "401" || FAILED_TESTS=$((FAILED_TESTS + 1))

# Test 5: POST with missing colon in token
run_test "POST /message (missing colon)" "${BASE_URL}${ENDPOINT}" "POST" "-H 'Content-Type: application/json' -H 'Authorization: Bearer ${TEST_API_TOKEN}'" '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' "401" || FAILED_TESTS=$((FAILED_TESTS + 1))

# Test 6: POST with initialize method
run_test "POST /message (initialize)" "${BASE_URL}${ENDPOINT}" "POST" "-H 'Content-Type: application/json' -H 'Authorization: ${AUTH_HEADER}'" '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test-client","version":"1.0.0"}}}' "200" || FAILED_TESTS=$((FAILED_TESTS + 1))

# Test 7: List available tools
echo -e "\n${YELLOW}Test: List Tools${NC}"
TOOLS_RESPONSE=$(send_mcp_message "tools/list" "{}" "100")
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

# Test 8: Call get-users tool
test_tool_call "Call get-users tool" "get-users" "{}" || FAILED_TESTS=$((FAILED_TESTS + 1))

# Test 9: Call get-pipelines tool
test_tool_call "Call get-pipelines tool" "get-pipelines" "{}" || FAILED_TESTS=$((FAILED_TESTS + 1))

# Test 10: Call get-stages tool
test_tool_call "Call get-stages tool" "get-stages" "{}" || FAILED_TESTS=$((FAILED_TESTS + 1))

# Test 11: Call get-deals tool (with limit)
test_tool_call "Call get-deals tool (limit 5)" "get-deals" "{\"limit\":5}" || FAILED_TESTS=$((FAILED_TESTS + 1))

# Summary
echo -e "\n${GREEN}=== Test Summary ===${NC}"
if [ $FAILED_TESTS -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}✗ ${FAILED_TESTS} test(s) failed${NC}"
    echo -e "\n${YELLOW}Recent server logs:${NC}"
    tail -30 /tmp/pipedrive-mcp-server-http.log
    exit 1
fi

