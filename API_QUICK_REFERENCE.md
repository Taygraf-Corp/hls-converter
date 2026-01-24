# API Quick Reference

## Base URL
```
http://localhost:3000
```

## Authentication

Set in `.env`:
```bash
API_KEY=your-secret-key-here
```

Generate a key:
```bash
npm run generate-key
```

Include in requests (choose one method):
```bash
# Method 1: Authorization Header
-H "Authorization: Bearer your-api-key-here"

# Method 2: X-API-Key Header
-H "X-API-Key: your-api-key-here"

# Method 3: Query Parameter
?api_key=your-api-key-here
```

---

## Endpoints at a Glance

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/health` | No | Check service health |
| GET | `/api/info` | No | Get service configuration |
| POST | `/api/upload` | Yes | Upload & convert video |
| POST | `/api/validate` | Yes | Validate video file |
| POST | `/api/metadata` | Yes | Get video metadata |
| POST | `/api/process-from-storage` | Yes | Process stored video |

---

## Quick Examples

### Upload Video
```bash
curl -X POST http://localhost:3000/api/upload \
  -H "Authorization: Bearer your-api-key-here" \
  -F "video=@video.mp4" \
  -F "videoId=my-video-123"
```

### Validate Video
```bash
curl -X POST http://localhost:3000/api/validate \
  -H "Authorization: Bearer your-api-key-here" \
  -F "video=@video.mp4"
```

### Get Metadata
```bash
curl -X POST http://localhost:3000/api/metadata \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key-here" \
  -d '{"videoPath":"Videos/video.mp4"}'
```

### Process from Storage
```bash
curl -X POST http://localhost:3000/api/process-from-storage \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key-here" \
  -d '{"videoPath":"Videos/video.mp4","videoId":"video-123"}'
```

---

## Response Format

### Success
```json
{
  "success": true,
  "data": { /* ... */ }
}
```

### Error
```json
{
  "success": false,
  "error": "Error message"
}
```

---

## HLS Output URL Pattern

```
https://ohfzckfunpsjncjjzfyz.supabase.co/storage/v1/object/public/FlutterFlow/{path}
```

Example:
```
https://ohfzckfunpsjncjjzfyz.supabase.co/storage/v1/object/public/FlutterFlow/converted/video-123/hls/master.m3u8
```

---

## Supported Formats
MP4, MOV, AVI, WebM, MKV

## File Size Limit
500 MB

## Processing Time
Approximately 0.3-0.5x of video duration (e.g., 10s video = ~3-5s processing)

---

## Common Error Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Bad Request (invalid input) |
| 500 | Server Error (processing failed) |

---

## Full Documentation
See [API_DOCUMENTATION.md](./API_DOCUMENTATION.md) for complete documentation.

## OpenAPI Spec
See [openapi.yaml](./openapi.yaml) for OpenAPI/Swagger specification.
