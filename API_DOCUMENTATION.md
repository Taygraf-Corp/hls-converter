# HLS Video Conversion Service - API Documentation

**Version:** 1.0.0  
**Base URL:** `http://localhost:3000` (or your deployment URL)  
**Content Type:** `application/json` (except file uploads)

---

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Rate Limits](#rate-limits)
4. [Endpoints](#endpoints)
   - [Health Check](#health-check)
   - [Service Info](#service-info)
   - [Upload Video](#upload-video)
   - [Validate Video](#validate-video)
   - [Get Video Metadata](#get-video-metadata)
   - [Process from Storage](#process-from-storage)
5. [Response Format](#response-format)
6. [Error Codes](#error-codes)
7. [Video Requirements](#video-requirements)
8. [HLS Output Structure](#hls-output-structure)
9. [Code Examples](#code-examples)

---

## Overview

The HLS Video Conversion Service provides RESTful API endpoints for converting video files to HTTP Live Streaming (HLS) format with adaptive bitrate streaming. The service automatically detects video aspect ratios and generates optimized resolution ladders for the best viewing experience.

### Key Features

- ✅ Automatic aspect ratio detection (portrait, landscape, square)
- ✅ Smart resolution selection based on source dimensions
- ✅ Adaptive bitrate streaming with multiple quality variants
- ✅ H.264/AAC codec for universal compatibility
- ✅ Direct upload to Supabase Storage with public URLs
- ✅ Support for MP4, MOV, AVI, WebM, and MKV formats
- ✅ Video validation and metadata extraction
- ✅ Processing from storage or direct upload

---

## Authentication

The API supports optional API key authentication. When enabled, all video processing endpoints require a valid API key.

### Enabling Authentication

Set the `API_KEY` environment variable in your `.env` file:

```bash
API_KEY=your-secret-key-here
```

**Generate a secure API key:**
```bash
npm run generate-key
```

### Providing API Key in Requests

The API key can be provided in three ways:

**Method 1: Authorization Header (Recommended)**
```http
Authorization: Bearer your-api-key-here
```

**Method 2: X-API-Key Header**
```http
X-API-Key: your-api-key-here
```

**Method 3: Query Parameter**
```http
?api_key=your-api-key-here
```

### Authentication Behavior

- **If `API_KEY` is set:** All protected endpoints require authentication
- **If `API_KEY` is not set:** Endpoints are publicly accessible (development mode)
- **Invalid key:** Returns `401 Unauthorized`
- **Missing key (when required):** Returns `401 Unauthorized`

### Protected Endpoints

The following endpoints require authentication when `API_KEY` is set:
- `POST /api/upload`
- `POST /api/validate`
- `POST /api/metadata`
- `POST /api/process-from-storage`

### Public Endpoints

These endpoints are always public:
- `GET /health`
- `GET /api/info`

---

## Rate Limits

**File Size Limit:** 500 MB per upload  
**Concurrent Processing:** 3 jobs (configurable via `MAX_CONCURRENT_JOBS` env variable)

---

## Endpoints

### Health Check

Check if the service is running and healthy.

**Endpoint:** `GET /health`

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-01-24T16:23:58.145Z"
}
```

**Status Codes:**
- `200 OK` - Service is healthy

**Example:**
```bash
curl http://localhost:3000/health
```

---

### Service Info

Get information about supported formats, resolution sets, and storage configuration.

**Endpoint:** `GET /api/info`

**Response:**
```json
{
  "success": true,
  "info": {
    "supportedFormats": ["mp4", "mov", "avi", "webm", "mkv"],
    "maxFileSize": "500MB",
    "resolutionSets": {
      "portrait": [
        { "width": 360, "height": 640, "bitrate": 400000 },
        { "width": 480, "height": 854, "bitrate": 800000 },
        { "width": 720, "height": 1280, "bitrate": 1200000 },
        { "width": 1080, "height": 1920, "bitrate": 2000000 }
      ],
      "landscape": [
        { "width": 640, "height": 360, "bitrate": 400000 },
        { "width": 854, "height": 480, "bitrate": 800000 },
        { "width": 1280, "height": 720, "bitrate": 1200000 },
        { "width": 1920, "height": 1080, "bitrate": 2000000 }
      ],
      "square": [
        { "width": 360, "height": 360, "bitrate": 400000 },
        { "width": 480, "height": 480, "bitrate": 800000 },
        { "width": 720, "height": 720, "bitrate": 1200000 },
        { "width": 1080, "height": 1080, "bitrate": 2000000 }
      ]
    },
    "storage": {
      "bucket": "FlutterFlow",
      "folder": "converted"
    }
  }
}
```

**Status Codes:**
- `200 OK` - Success

**Example:**
```bash
curl http://localhost:3000/api/info
```

---

### Upload Video

Upload a video file and convert it to HLS format.

**Endpoint:** `POST /api/upload`

**Content-Type:** `multipart/form-data`

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `video` | File | Yes | Video file to convert (max 500MB) |
| `userId` | String | No | User ID for tracking |
| `videoId` | String | No | Custom video ID (auto-generated if not provided) |
| `postId` | String | No | Post ID to update with HLS URL |

**Request Example:**
```bash
curl -X POST http://localhost:3000/api/upload \
  -H "Authorization: Bearer your-api-key-here" \
  -F "video=@/path/to/video.mp4" \
  -F "videoId=my-custom-video-id" \
  -F "userId=user-123" \
  -F "postId=post-456"
```

**Success Response (200 OK):**
```json
{
  "success": true,
  "message": "Video processed successfully",
  "data": {
    "outputFiles": [
      "converted/my-custom-video-id/hls/640p.m3u8",
      "converted/my-custom-video-id/hls/640p_000.ts",
      "converted/my-custom-video-id/hls/854p.m3u8",
      "converted/my-custom-video-id/hls/854p_000.ts",
      "converted/my-custom-video-id/hls/master.m3u8"
    ],
    "metadata": {
      "width": 576,
      "height": 1024,
      "duration": 7.011995,
      "aspectRatio": "portrait",
      "resolutions": [
        { "width": 360, "height": 640, "bitrate": 400000 },
        { "width": 480, "height": 854, "bitrate": 800000 }
      ]
    },
    "processingTime": 2466,
    "masterPlaylist": "converted/my-custom-video-id/hls/master.m3u8"
  }
}
```

**Error Response (400 Bad Request):**
```json
{
  "success": false,
  "error": "No video file provided"
}
```

**Error Response (500 Internal Server Error):**
```json
{
  "success": false,
  "error": "Invalid video file"
}
```

**Status Codes:**
- `200 OK` - Video processed successfully
- `400 Bad Request` - Missing or invalid parameters
- `500 Internal Server Error` - Processing failed

**Public URL Construction:**

After successful upload, construct the public URL:
```
https://[SUPABASE_URL]/storage/v1/object/public/[BUCKET]/[masterPlaylist]
```

Example:
```
https://ohfzckfunpsjncjjzfyz.supabase.co/storage/v1/object/public/FlutterFlow/converted/my-custom-video-id/hls/master.m3u8
```

**Notes:**
- Processing time varies based on video length and resolution
- If `postId` is provided, the service will automatically update the post's `hls_url` field
- Temporary files are cleaned up automatically after processing

---

### Validate Video

Validate a video file without processing it. Useful for pre-upload validation.

**Endpoint:** `POST /api/validate`

**Content-Type:** `multipart/form-data`

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `video` | File | Yes | Video file to validate |

**Request Example:**
```bash
curl -X POST http://localhost:3000/api/validate \
  -H "Authorization: Bearer your-api-key-here" \
  -F "video=@/path/to/video.mp4"
```

**Success Response (200 OK):**
```json
{
  "success": true,
  "valid": true,
  "metadata": {
    "width": 1920,
    "height": 1080,
    "duration": 120.5,
    "aspectRatio": "landscape",
    "bitrate": 5000000
  }
}
```

**Error Response (400 Bad Request):**
```json
{
  "success": false,
  "valid": false,
  "error": "Invalid or corrupted video file"
}
```

**Status Codes:**
- `200 OK` - Video is valid
- `400 Bad Request` - Video is invalid or missing
- `500 Internal Server Error` - Validation failed

---

### Get Video Metadata

Get metadata from a video file stored in Supabase Storage without converting it.

**Endpoint:** `POST /api/metadata`

**Content-Type:** `application/json`

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `videoPath` | String | Yes | Path to video in storage bucket |
| `bucket` | String | No | Storage bucket name (defaults to source bucket) |

**Request Example:**
```bash
curl -X POST http://localhost:3000/api/metadata \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key-here" \
  -d '{
    "videoPath": "Videos/example.mp4",
    "bucket": "FlutterFlow"
  }'
```

**Success Response (200 OK):**
```json
{
  "success": true,
  "metadata": {
    "width": 1280,
    "height": 720,
    "duration": 45.2,
    "aspectRatio": "landscape",
    "bitrate": 3500000
  }
}
```

**Error Response (400 Bad Request):**
```json
{
  "success": false,
  "error": "videoPath is required"
}
```

**Status Codes:**
- `200 OK` - Metadata retrieved successfully
- `400 Bad Request` - Missing parameters
- `500 Internal Server Error` - Failed to get metadata

---

### Process from Storage

Process a video that's already stored in Supabase Storage.

**Endpoint:** `POST /api/process-from-storage`

**Content-Type:** `application/json`

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `videoPath` | String | Yes | Path to video in storage bucket |
| `bucket` | String | No | Storage bucket name (defaults to source bucket) |
| `userId` | String | No | User ID for tracking |
| `videoId` | String | No | Custom video ID |

**Request Example:**
```bash
curl -X POST http://localhost:3000/api/process-from-storage \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key-here" \
  -d '{
    "videoPath": "Videos/my-video.mp4",
    "bucket": "FlutterFlow",
    "videoId": "custom-id-123",
    "userId": "user-456"
  }'
```

**Success Response (200 OK):**
```json
{
  "success": true,
  "message": "Video processed successfully",
  "data": {
    "outputFiles": [
      "converted/custom-id-123/hls/640p.m3u8",
      "converted/custom-id-123/hls/640p_000.ts",
      "converted/custom-id-123/hls/1280p.m3u8",
      "converted/custom-id-123/hls/1280p_000.ts",
      "converted/custom-id-123/hls/master.m3u8"
    ],
    "metadata": {
      "width": 1920,
      "height": 1080,
      "duration": 60.0,
      "aspectRatio": "landscape",
      "resolutions": [
        { "width": 640, "height": 360, "bitrate": 400000 },
        { "width": 1280, "height": 720, "bitrate": 1200000 }
      ]
    },
    "processingTime": 15420,
    "masterPlaylist": "converted/custom-id-123/hls/master.m3u8"
  }
}
```

**Error Response (400 Bad Request):**
```json
{
  "success": false,
  "error": "videoPath is required"
}
```

**Status Codes:**
- `200 OK` - Video processed successfully
- `400 Bad Request` - Missing parameters
- `500 Internal Server Error` - Processing failed

---

## Response Format

### Success Response Structure

```json
{
  "success": true,
  "message": "Operation completed successfully",
  "data": {
    // Endpoint-specific data
  }
}
```

### Error Response Structure

```json
{
  "success": false,
  "error": "Error message describing what went wrong"
}
```

---

## Error Codes

| HTTP Code | Description |
|-----------|-------------|
| `200` | Success - Request completed successfully |
| `400` | Bad Request - Invalid parameters or missing required fields |
| `404` | Not Found - Endpoint does not exist |
| `500` | Internal Server Error - Processing or server error |

### Common Error Messages

| Error Message | Cause | Solution |
|---------------|-------|----------|
| `No video file provided` | Missing video in form data | Include video file in request |
| `Only video files are allowed` | Invalid MIME type | Upload a valid video file (mp4, mov, etc.) |
| `Invalid video file` | Corrupted or unreadable video | Ensure video is valid and not corrupted |
| `File too large. Maximum size is 500MB` | File exceeds size limit | Compress or split the video |
| `videoPath is required` | Missing required parameter | Include videoPath in request body |
| `Bucket not found` | Storage bucket doesn't exist | Verify bucket configuration |

---

## Video Requirements

### Supported Formats

- MP4 (`.mp4`)
- QuickTime (`.mov`)
- AVI (`.avi`)
- WebM (`.webm`)
- Matroska (`.mkv`)

### Limitations

- **Maximum File Size:** 500 MB
- **Minimum Resolution:** No minimum (but very low resolutions may not produce multiple variants)
- **Maximum Resolution:** No hard limit (but processing time increases with resolution)
- **Supported Codecs:** Most common video codecs (H.264, H.265, VP8, VP9, etc.)

### Recommendations

- **Codec:** H.264 for fastest processing (no re-encoding needed)
- **Container:** MP4 for best compatibility
- **Bitrate:** At least 1 Mbps for good quality
- **Frame Rate:** 24-60 fps (higher frame rates increase file size)

---

## HLS Output Structure

### Directory Structure

```
converted/
  └── {videoId}/
      └── hls/
          ├── master.m3u8          # Master playlist
          ├── 360p.m3u8            # Low quality variant playlist
          ├── 360p_000.ts          # Low quality video segments
          ├── 480p.m3u8            # Medium quality variant playlist
          ├── 480p_000.ts          # Medium quality video segments
          ├── 720p.m3u8            # High quality variant playlist
          ├── 720p_000.ts          # High quality video segments
          ├── 1080p.m3u8           # Ultra quality variant playlist
          └── 1080p_000.ts         # Ultra quality video segments
```

### Resolution Ladders

#### Portrait Videos (9:16)
- 360x640 @ 400 kbps
- 480x854 @ 800 kbps
- 720x1280 @ 1.2 Mbps
- 1080x1920 @ 2 Mbps

#### Landscape Videos (16:9)
- 640x360 @ 400 kbps
- 854x480 @ 800 kbps
- 1280x720 @ 1.2 Mbps
- 1920x1080 @ 2 Mbps

#### Square Videos (1:1)
- 360x360 @ 400 kbps
- 480x480 @ 800 kbps
- 720x720 @ 1.2 Mbps
- 1080x1080 @ 2 Mbps

**Note:** Only resolutions equal to or smaller than the source video are generated.

### Master Playlist Example

```m3u8
#EXTM3U
#EXT-X-VERSION:3

#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=360x640
360p.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=480x854
480p.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=720x1280
720p.m3u8
```

---

## Code Examples

### JavaScript/Node.js

#### Upload Video

```javascript
const FormData = require('form-data');
const fs = require('fs');
const axios = require('axios');

async function uploadVideo(filePath, videoId, apiKey) {
  const form = new FormData();
  form.append('video', fs.createReadStream(filePath));
  form.append('videoId', videoId);
  
  try {
    const response = await axios.post('http://localhost:3000/api/upload', form, {
      headers: {
        ...form.getHeaders(),
        'Authorization': `Bearer ${apiKey}`
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
    
    console.log('Success:', response.data);
    
    // Construct public URL
    const baseUrl = 'https://ohfzckfunpsjncjjzfyz.supabase.co/storage/v1/object/public/FlutterFlow';
    const hlsUrl = `${baseUrl}/${response.data.data.masterPlaylist}`;
    
    console.log('HLS URL:', hlsUrl);
    
    return response.data;
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    throw error;
  }
}

// Usage
const apiKey = process.env.API_KEY || 'your-api-key-here';
uploadVideo('./my-video.mp4', 'video-123', apiKey);
```

#### Validate Video

```javascript
async function validateVideo(filePath, apiKey) {
  const form = new FormData();
  form.append('video', fs.createReadStream(filePath));
  
  try {
    const response = await axios.post('http://localhost:3000/api/validate', form, {
      headers: {
        ...form.getHeaders(),
        'Authorization': `Bearer ${apiKey}`
      }
    });
    
    if (response.data.valid) {
      console.log('Video is valid');
      console.log('Metadata:', response.data.metadata);
    } else {
      console.log('Video is invalid');
    }
    
    return response.data;
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    throw error;
  }
}
```

#### Process from Storage

```javascript
async function processFromStorage(videoPath, videoId, apiKey) {
  try {
    const response = await axios.post('http://localhost:3000/api/process-from-storage', {
      videoPath: videoPath,
      videoId: videoId,
      bucket: 'FlutterFlow'
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });
    
    console.log('Processing complete:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    throw error;
  }
}

// Usage
processFromStorage('Videos/my-video.mp4', 'video-456', apiKey);
```

---

### Python

#### Upload Video

```python
import requests
import os

def upload_video(file_path, video_id, api_key):
    url = 'http://localhost:3000/api/upload'
    headers = {'Authorization': f'Bearer {api_key}'}
    
    with open(file_path, 'rb') as video_file:
        files = {'video': video_file}
        data = {'videoId': video_id}
        
        response = requests.post(url, files=files, data=data, headers=headers)
        
        if response.status_code == 200:
            result = response.json()
            print('Success:', result)
            
            # Construct public URL
            base_url = 'https://ohfzckfunpsjncjjzfyz.supabase.co/storage/v1/object/public/FlutterFlow'
            hls_url = f"{base_url}/{result['data']['masterPlaylist']}"
            print('HLS URL:', hls_url)
            
            return result
        else:
            print('Error:', response.json())
            return None

# Usage
api_key = os.getenv('API_KEY', 'your-api-key-here')
upload_video('./my-video.mp4', 'video-123', api_key)
```

#### Get Metadata

```python
def get_metadata(video_path):
    url = 'http://localhost:3000/api/metadata'
    
    payload = {
        'videoPath': video_path,
        'bucket': 'FlutterFlow'
    }
    
    response = requests.post(url, json=payload)
    
    if response.status_code == 200:
        result = response.json()
        print('Metadata:', result['metadata'])
        return result
    else:
        print('Error:', response.json())
        return None

# Usage
get_metadata('Videos/my-video.mp4')
```

---

### cURL

#### Upload Video

```bash
curl -X POST http://localhost:3000/api/upload \
  -F "video=@./my-video.mp4" \
  -F "videoId=video-123" \
  -F "userId=user-456"
```

#### Validate Video

```bash
curl -X POST http://localhost:3000/api/validate \
  -F "video=@./my-video.mp4"
```

#### Get Metadata

```bash
curl -X POST http://localhost:3000/api/metadata \
  -H "Content-Type: application/json" \
  -d '{"videoPath":"Videos/my-video.mp4","bucket":"FlutterFlow"}'
```

#### Process from Storage

```bash
curl -X POST http://localhost:3000/api/process-from-storage \
  -H "Content-Type: application/json" \
  -d '{
    "videoPath": "Videos/my-video.mp4",
    "videoId": "video-123",
    "bucket": "FlutterFlow"
  }'
```

---

### React/Frontend

```javascript
async function uploadVideoFromBrowser(file, videoId) {
  const formData = new FormData();
  formData.append('video', file);
  formData.append('videoId', videoId);
  
  try {
    const response = await fetch('http://localhost:3000/api/upload', {
      method: 'POST',
      body: formData
    });
    
    const result = await response.json();
    
    if (result.success) {
      // Construct HLS URL
      const baseUrl = 'https://ohfzckfunpsjncjjzfyz.supabase.co/storage/v1/object/public/FlutterFlow';
      const hlsUrl = `${baseUrl}/${result.data.masterPlaylist}`;
      
      // Use with video player
      playHlsVideo(hlsUrl);
      
      return result;
    } else {
      console.error('Upload failed:', result.error);
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

// Example with file input
function VideoUploader() {
  const handleFileChange = async (event) => {
    const file = event.target.files[0];
    if (file) {
      const videoId = `video-${Date.now()}`;
      await uploadVideoFromBrowser(file, videoId);
    }
  };
  
  return (
    <input 
      type="file" 
      accept="video/*" 
      onChange={handleFileChange} 
    />
  );
}
```

---

## Best Practices

### 1. Video ID Management

Always provide a `videoId` to ensure predictable storage paths:

```javascript
const videoId = `user-${userId}-${timestamp}`;
```

### 2. Progress Monitoring

For long videos, implement client-side progress monitoring:

```javascript
const xhr = new XMLHttpRequest();

xhr.upload.addEventListener('progress', (e) => {
  if (e.lengthComputable) {
    const percentComplete = (e.loaded / e.total) * 100;
    console.log(`Upload: ${percentComplete}%`);
  }
});

xhr.addEventListener('load', () => {
  console.log('Processing video...');
});
```

### 3. Error Handling

Always handle errors gracefully:

```javascript
try {
  const result = await uploadVideo(file, videoId);
  // Success
} catch (error) {
  if (error.response?.status === 400) {
    // Invalid input
  } else if (error.response?.status === 500) {
    // Server error - retry?
  }
}
```

### 4. HLS Player Integration

Use HLS.js for browsers that don't support HLS natively:

```html
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<video id="video" controls></video>

<script>
  const video = document.getElementById('video');
  const hlsUrl = 'https://...your-hls-url.../master.m3u8';
  
  if (Hls.isSupported()) {
    const hls = new Hls();
    hls.loadSource(hlsUrl);
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Native HLS support (Safari)
    video.src = hlsUrl;
  }
</script>
```

---

## Support

For issues, feature requests, or questions:
- Check the logs for detailed error messages
- Review the test scripts: `test-hls-endpoint.sh` and `verify-signed-url.sh`
- Refer to `TEST_RESULTS.md` for verified functionality

---

## Changelog

### Version 1.0.0 (2026-01-24)
- Initial release
- Support for MP4, MOV, AVI, WebM, MKV
- Smart resolution selection
- HLS conversion with adaptive bitrate
- Supabase Storage integration
- Multiple processing endpoints
