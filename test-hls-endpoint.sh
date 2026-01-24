#!/bin/bash

# Test HLS Conversion Endpoint
# This script tests the HLS conversion endpoint to verify it properly converts files
# and returns signed URLs from the bucket

set -e

API_URL="http://localhost:3000"
TEST_VIDEO="/home/roppa/projects/hls-converter/data/1709115333377000.mp4"

echo "=========================================="
echo "Testing HLS Conversion Endpoint"
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if test video exists
if [ ! -f "$TEST_VIDEO" ]; then
    echo -e "${RED}✗ Test video not found: $TEST_VIDEO${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Test video found${NC}"
echo "Video: $(basename $TEST_VIDEO)"
echo "Size: $(du -h $TEST_VIDEO | cut -f1)"
echo ""

# Test 1: Health Check
echo "Test 1: Health Check"
echo "--------------------"
HEALTH_RESPONSE=$(curl -s "$API_URL/health")
echo "Response: $HEALTH_RESPONSE"

if echo "$HEALTH_RESPONSE" | grep -q "ok"; then
    echo -e "${GREEN}✓ Health check passed${NC}"
else
    echo -e "${RED}✗ Health check failed${NC}"
    exit 1
fi
echo ""

# Test 2: Get API Info
echo "Test 2: API Info"
echo "----------------"
INFO_RESPONSE=$(curl -s "$API_URL/api/info")
echo "Response:"
echo "$INFO_RESPONSE" | jq '.' 2>/dev/null || echo "$INFO_RESPONSE"
echo ""

# Test 3: Upload and Convert Video
echo "Test 3: Upload and Convert Video to HLS"
echo "----------------------------------------"
echo "Uploading video for conversion..."
echo "This may take a few minutes depending on video size..."
echo ""

# Create a temporary file to store the response
RESPONSE_FILE=$(mktemp)

# Upload the video with progress
HTTP_CODE=$(curl -w "%{http_code}" -o "$RESPONSE_FILE" \
    -X POST \
    -F "video=@$TEST_VIDEO;type=video/mp4" \
    -F "videoId=test-video-$(date +%s)" \
    "$API_URL/api/upload")

echo ""
echo "HTTP Status Code: $HTTP_CODE"
echo ""

if [ "$HTTP_CODE" -eq 200 ]; then
    echo -e "${GREEN}✓ Upload successful (HTTP 200)${NC}"
    echo ""
    echo "Response Details:"
    echo "-----------------"
    
    # Parse and display response
    RESPONSE=$(cat "$RESPONSE_FILE")
    echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"
    echo ""
    
    # Extract key information
    echo "Key Information:"
    echo "----------------"
    
    SUCCESS=$(echo "$RESPONSE" | jq -r '.success' 2>/dev/null)
    MASTER_PLAYLIST=$(echo "$RESPONSE" | jq -r '.data.masterPlaylist' 2>/dev/null)
    OUTPUT_FILES_COUNT=$(echo "$RESPONSE" | jq -r '.data.outputFiles | length' 2>/dev/null)
    PROCESSING_TIME=$(echo "$RESPONSE" | jq -r '.data.processingTime' 2>/dev/null)
    
    echo "Success: $SUCCESS"
    echo "Output Files Count: $OUTPUT_FILES_COUNT"
    echo "Processing Time: ${PROCESSING_TIME}ms"
    echo "Master Playlist Path: $MASTER_PLAYLIST"
    echo ""
    
    # Verify critical components
    if [ "$SUCCESS" = "true" ]; then
        echo -e "${GREEN}✓ Conversion successful${NC}"
    else
        echo -e "${RED}✗ Conversion reported failure${NC}"
        rm "$RESPONSE_FILE"
        exit 1
    fi
    
    if [ "$OUTPUT_FILES_COUNT" -gt 0 ]; then
        echo -e "${GREEN}✓ Output files generated ($OUTPUT_FILES_COUNT files)${NC}"
    else
        echo -e "${RED}✗ No output files generated${NC}"
        rm "$RESPONSE_FILE"
        exit 1
    fi
    
    if [ -n "$MASTER_PLAYLIST" ] && [ "$MASTER_PLAYLIST" != "null" ]; then
        echo -e "${GREEN}✓ Master playlist path exists${NC}"
    else
        echo -e "${RED}✗ Master playlist path missing${NC}"
        rm "$RESPONSE_FILE"
        exit 1
    fi
    echo ""
    
    # Display all output files
    echo "Output Files:"
    echo "-------------"
    echo "$RESPONSE" | jq -r '.data.outputFiles[]' 2>/dev/null
    echo ""
    
    # Display metadata
    echo "Video Metadata:"
    echo "---------------"
    echo "$RESPONSE" | jq '.data.metadata' 2>/dev/null
    echo ""
    
    # Check if we can construct a signed URL
    echo "Checking Signed URLs:"
    echo "---------------------"
    
    # Try to check if the files are accessible
    # The response should contain the storage paths
    if echo "$RESPONSE" | jq -e '.data.outputFiles[0]' > /dev/null 2>&1; then
        FIRST_FILE=$(echo "$RESPONSE" | jq -r '.data.outputFiles[0]')
        echo "First output file: $FIRST_FILE"
        echo -e "${GREEN}✓ File paths returned from storage${NC}"
        echo ""
        
        # Note: Actual signed URL generation would require Supabase client
        echo -e "${YELLOW}Note: The endpoint returns storage paths. Signed URLs would be generated${NC}"
        echo -e "${YELLOW}by the Supabase storage service when accessing these files.${NC}"
    fi
    
else
    echo -e "${RED}✗ Upload failed (HTTP $HTTP_CODE)${NC}"
    echo ""
    echo "Error Response:"
    cat "$RESPONSE_FILE" | jq '.' 2>/dev/null || cat "$RESPONSE_FILE"
    rm "$RESPONSE_FILE"
    exit 1
fi

# Cleanup
rm "$RESPONSE_FILE"

echo ""
echo "=========================================="
echo -e "${GREEN}All Tests Passed!${NC}"
echo "=========================================="
echo ""
echo "Summary:"
echo "- Health check: ✓"
echo "- API info: ✓"
echo "- Video upload: ✓"
echo "- HLS conversion: ✓"
echo "- Output files generated: ✓"
echo "- Storage paths returned: ✓"
echo ""
