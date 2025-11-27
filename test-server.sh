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
            echo "Response: $(echo "$body" | head -c 200)..."
        fi
        return 0
    else
        echo -e "${RED}✗ Failed (Expected HTTP ${expected_status}, got ${http_code})${NC}"
        echo "Response: $body"
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

# Test 2: SSE endpoint without credentials (should fail or work depending on JWT config)
run_test "SSE Endpoint (no credentials)" "${BASE_URL}${SSE_ENDPOINT}" "GET" "-H 'Accept: text/event-stream' --max-time 2" "" "401" || FAILED_TESTS=$((FAILED_TESTS + 1))

# Test 3: SSE endpoint with credentials
run_test "SSE Endpoint (with credentials)" "${BASE_URL}${SSE_ENDPOINT}" "GET" "-H 'Accept: text/event-stream' -H 'Authorization: ${AUTH_HEADER}' --max-time 2" "" "200" || FAILED_TESTS=$((FAILED_TESTS + 1))

# Test 4: POST to message endpoint without sessionId (should fail for SSE mode)
run_test "POST /message (no sessionId)" "${BASE_URL}${ENDPOINT}" "POST" "-H 'Content-Type: application/json' -H 'Authorization: ${AUTH_HEADER}'" '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' "400" || FAILED_TESTS=$((FAILED_TESTS + 1))

# Test 5: POST to message endpoint with invalid sessionId
run_test "POST /message (invalid sessionId)" "${BASE_URL}${ENDPOINT}?sessionId=invalid-session" "POST" "-H 'Content-Type: application/json' -H 'Authorization: ${AUTH_HEADER}'" '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' "404" || FAILED_TESTS=$((FAILED_TESTS + 1))

# Test 6: Test with malformed Authorization header
run_test "SSE Endpoint (malformed auth)" "${BASE_URL}${SSE_ENDPOINT}" "GET" "-H 'Accept: text/event-stream' -H 'Authorization: InvalidFormat' --max-time 2" "" "401" || FAILED_TESTS=$((FAILED_TESTS + 1))

# Test 7: Test with missing colon in token
run_test "SSE Endpoint (missing colon)" "${BASE_URL}${SSE_ENDPOINT}" "GET" "-H 'Accept: text/event-stream' -H 'Authorization: Bearer ${TEST_API_TOKEN}' --max-time 2" "" "401" || FAILED_TESTS=$((FAILED_TESTS + 1))

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

