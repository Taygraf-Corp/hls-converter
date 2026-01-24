# API Quick Reference

## Base URL
```
http://localhost:3000
```

## Endpoints at a Glance

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Check service health |
| GET | `/api/info` | Get service configuration |
| POST | `/api/upload` | Upload & convert video |
| POST | `/api/validate` | Validate video file |
| POST | `/api/metadata` | Get video metadata |
| POST | `/api/process-from-storage` | Process stored video |

---

## Quick Examples

### Upload Video
```bash
curl -X POST http://localhost:3000/api/upload \
  -F "video=@video.mp4" \
  -F "videoId=my-video-123"
```

### Validate Video
```bash
curl -X POST http://localhost:3000/api/validate \
  -F "video=@video.mp4"
```

### Get Metadata
```bash
curl -X POST http://localhost:3000/api/metadata \
  -H "Content-Type: application/json" \
  -d '{"videoPath":"Videos/video.mp4"}'
```

### Process from Storage
```bash
curl -X POST http://localhost:3000/api/process-from-storage \
  -H "Content-Type: application/json" \
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
