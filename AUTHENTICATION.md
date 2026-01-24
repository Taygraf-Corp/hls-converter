# API Key Authentication

This service supports API key authentication to secure video processing endpoints.

## Quick Start

### 1. Generate an API Key

```bash
npm run generate-key
```

This will output a secure random key:
```
🔑 Generated API Key

══════════════════════════════════════════════════════════════════════

abc123XYZ...your-random-key-here

══════════════════════════════════════════════════════════════════════

📋 Add to your .env file:

API_KEY=abc123XYZ...your-random-key-here
```

### 2. Add to .env File

```bash
API_KEY=abc123XYZ...your-random-key-here
```

### 3. Restart the Server

```bash
npm run server
```

You should see:
```
🔐 API key authentication: ENABLED
```

## Using API Keys

### Method 1: Authorization Header (Recommended)

```bash
curl -H "Authorization: Bearer your-api-key-here" \
  http://localhost:3000/api/upload
```

### Method 2: X-API-Key Header

```bash
curl -H "X-API-Key: your-api-key-here" \
  http://localhost:3000/api/upload
```

### Method 3: Query Parameter

```bash
curl "http://localhost:3000/api/upload?api_key=your-api-key-here"
```

## Protected Endpoints

When `API_KEY` is set, these endpoints require authentication:

- `POST /api/upload` - Upload and convert video
- `POST /api/validate` - Validate video file
- `POST /api/metadata` - Get video metadata
- `POST /api/process-from-storage` - Process video from storage

## Public Endpoints

These endpoints are always accessible without authentication:

- `GET /health` - Health check
- `GET /api/info` - Service information

## Development Mode

If `API_KEY` is not set in the environment, authentication is **disabled** and all endpoints are publicly accessible. This is useful for local development.

## Error Responses

### 401 Unauthorized - No API Key

```json
{
  "success": false,
  "error": "Authentication required",
  "message": "Please provide a valid API key via Authorization header, X-API-Key header, or api_key query parameter"
}
```

### 401 Unauthorized - Invalid API Key

```json
{
  "success": false,
  "error": "Invalid API key",
  "message": "The provided API key is not valid"
}
```

## Security Best Practices

### ✅ DO:

- Use HTTPS in production to prevent key interception
- Store API keys in environment variables, never in code
- Use different API keys for different environments (dev, staging, prod)
- Rotate API keys periodically
- Use the Authorization header method (more secure than query parameters)
- Keep API keys secret and never commit them to version control

### ❌ DON'T:

- Expose API keys in client-side code
- Share API keys via email or insecure channels
- Use the same API key across multiple projects
- Include API keys in URLs when possible (prefer headers)
- Log API keys in application logs

## Code Examples

### JavaScript/Node.js

```javascript
const axios = require('axios');
const FormData = require('form-data');

const API_KEY = process.env.API_KEY;

async function uploadVideo(filePath) {
  const form = new FormData();
  form.append('video', fs.createReadStream(filePath));
  
  const response = await axios.post('http://localhost:3000/api/upload', form, {
    headers: {
      ...form.getHeaders(),
      'Authorization': `Bearer ${API_KEY}`
    }
  });
  
  return response.data;
}
```

### Python

```python
import os
import requests

API_KEY = os.getenv('API_KEY')

def upload_video(file_path):
    headers = {'Authorization': f'Bearer {API_KEY}'}
    
    with open(file_path, 'rb') as f:
        files = {'video': f}
        response = requests.post(
            'http://localhost:3000/api/upload',
            files=files,
            headers=headers
        )
    
    return response.json()
```

### cURL

```bash
# Store API key in environment variable
export API_KEY="your-api-key-here"

# Use in request
curl -X POST http://localhost:3000/api/upload \
  -H "Authorization: Bearer $API_KEY" \
  -F "video=@video.mp4"
```

## Testing Authentication

### Test with Valid Key

```bash
curl -X POST http://localhost:3000/api/upload \
  -H "Authorization: Bearer your-valid-key" \
  -F "video=@test.mp4"
```

Expected: `200 OK` with successful conversion

### Test with Invalid Key

```bash
curl -X POST http://localhost:3000/api/upload \
  -H "Authorization: Bearer invalid-key" \
  -F "video=@test.mp4"
```

Expected: `401 Unauthorized`

```json
{
  "success": false,
  "error": "Invalid API key"
}
```

### Test without Key (when auth is enabled)

```bash
curl -X POST http://localhost:3000/api/upload \
  -F "video=@test.mp4"
```

Expected: `401 Unauthorized`

```json
{
  "success": false,
  "error": "Authentication required"
}
```

## Disabling Authentication

To disable authentication (e.g., for local development):

1. Remove or comment out `API_KEY` from `.env`:
   ```bash
   # API_KEY=your-key-here
   ```

2. Restart the server:
   ```bash
   npm run server
   ```

3. You should see:
   ```
   ⚠️  API key authentication: DISABLED (set API_KEY env variable to enable)
   ```

## Troubleshooting

### "Authentication required" error when key is set

**Problem:** Getting 401 even though API_KEY is in .env

**Solutions:**
- Ensure `.env` file is in the project root
- Restart the server after changing `.env`
- Check that the key in the request matches exactly (no extra spaces)
- Verify the header format: `Authorization: Bearer <key>` (note the space after "Bearer")

### Server says auth is disabled but API_KEY is set

**Problem:** Server logs show authentication is disabled

**Solutions:**
- Check `.env` file syntax: `API_KEY=value` (no spaces around `=`)
- Ensure `.env` file is being loaded (check if other env vars work)
- Restart the server
- Check for typos: `API_KEY` not `APIKEY` or `API_KEYS`

### Multiple environment files

If you have multiple `.env` files (`.env.local`, `.env.production`, etc.), ensure the correct one is being loaded for your environment.

## Implementation Details

The authentication middleware is located in:
```
src/middleware/auth.ts
```

Key features:
- Supports multiple authentication methods (header, query param)
- Constant-time string comparison to prevent timing attacks
- Detailed logging for debugging
- Graceful degradation when authentication is disabled
