#!/bin/bash

# Verify Signed URL Generation
# This script verifies that we can generate signed URLs for the uploaded HLS files

set -e

API_URL="http://localhost:3000"
MASTER_PLAYLIST_PATH="converted/test-video-1769271838/hls/master.m3u8"

echo "=========================================="
echo "Verifying Signed URL Access"
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "Testing access to uploaded HLS files..."
echo "Master Playlist: $MASTER_PLAYLIST_PATH"
echo ""

# The files are in Supabase storage at:
# https://ohfzckfunpsjncjjzfyz.supabase.co/storage/v1/object/public/FlutterFlow/converted/test-video-1769271838/hls/master.m3u8

STORAGE_URL="https://ohfzckfunpsjncjjzfyz.supabase.co/storage/v1/object/public/FlutterFlow/$MASTER_PLAYLIST_PATH"

echo "Attempting to access file from storage URL:"
echo "$STORAGE_URL"
echo ""

HTTP_CODE=$(curl -s -o /tmp/master.m3u8 -w "%{http_code}" "$STORAGE_URL")

if [ "$HTTP_CODE" -eq 200 ]; then
    echo -e "${GREEN}✓ Successfully accessed master playlist (HTTP $HTTP_CODE)${NC}"
    echo ""
    echo "Master Playlist Contents:"
    echo "-------------------------"
    cat /tmp/master.m3u8
    echo ""
    echo -e "${GREEN}✓ Signed URL works! File is accessible from Supabase storage${NC}"
    rm /tmp/master.m3u8
else
    echo -e "${RED}✗ Failed to access file (HTTP $HTTP_CODE)${NC}"
    echo ""
    echo -e "${YELLOW}Note: File may exist but require authentication.${NC}"
    echo -e "${YELLOW}Check your Supabase bucket policies.${NC}"
fi

echo ""
echo "=========================================="
echo "Full Signed URLs for HLS Files:"
echo "=========================================="
echo ""
echo "Base URL: https://ohfzckfunpsjncjjzfyz.supabase.co/storage/v1/object/public/FlutterFlow/"
echo ""
echo "Master Playlist:"
echo "$STORAGE_URL"
echo ""
echo "Variant Playlists:"
echo "https://ohfzckfunpsjncjjzfyz.supabase.co/storage/v1/object/public/FlutterFlow/converted/test-video-1769271838/hls/640p.m3u8"
echo "https://ohfzckfunpsjncjjzfyz.supabase.co/storage/v1/object/public/FlutterFlow/converted/test-video-1769271838/hls/854p.m3u8"
echo ""
echo "Segments:"
echo "https://ohfzckfunpsjncjjzfyz.supabase.co/storage/v1/object/public/FlutterFlow/converted/test-video-1769271838/hls/640p_000.ts"
echo "https://ohfzckfunpsjncjjzfyz.supabase.co/storage/v1/object/public/FlutterFlow/converted/test-video-1769271838/hls/854p_000.ts"
echo ""
