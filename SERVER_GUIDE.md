# Express Server - Video Processing API

A production-ready Express server for converting MP4 videos to HLS format with adaptive streaming.

## Features

- 🚀 **Fast Video Processing** - FFmpeg-powered conversion to HLS
- 📱 **Smart Resolution Detection** - Auto-detects portrait/landscape/square videos
- 🎯 **Multiple Quality Levels** - Generates adaptive bitrate streaming
- ☁️ **Supabase Integration** - Direct upload to Supabase Storage
- 🔒 **File Validation** - Validates videos before processing
- 🧹 **Auto Cleanup** - Automatic temporary file management

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Create a `.env` file:

```bash
# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key

# Storage
SOURCE_BUCKET=videos
SOURCE_FOLDER=Videos
TARGET_BUCKET=hls-videos
TARGET_FOLDER=converted

# Server
PORT=3000

# Processing
MAX_CONCURRENT_JOBS=3
TEMP_DIR=./temp
```

### 3. Start Server

```bash
# Development
npm run server

# Production
npm run build
npm run server:prod
```

The server will start on `http://localhost:3000`

## API Endpoints

### 1. Upload and Process Video

**POST** `/api/upload`

Upload a video file and convert it to HLS format.

**Request:**
- Content-Type: `multipart/form-data`
- Body:
  - `video` (file): Video file (required)
  - `userId` (string): User identifier (optional)
  - `videoId` (string): Video identifier (optional)

**Example with cURL:**
```bash
curl -X POST http://localhost:3000/api/upload \
  -F "video=@/path/to/video.mp4" \
  -F "userId=user-123" \
  -F "videoId=video-456"
```

**Example with JavaScript:**
```javascript
const formData = new FormData();
formData.append('video', fileInput.files[0]);
formData.append('userId', 'user-123');
formData.append('videoId', 'video-456');

const response = await fetch('http://localhost:3000/api/upload', {
  method: 'POST',
  body: formData
});

const result = await response.json();
console.log(result);
```

**Response:**
```json
{
  "success": true,
  "message": "Video processed successfully",
  "data": {
    "outputFiles": [
      "converted/user-123/video-456/hls/master.m3u8",
      "converted/user-123/video-456/hls/720p.m3u8",
      "converted/user-123/video-456/hls/480p.m3u8",
      "converted/user-123/video-456/hls/720p_000.ts"
    ],
    "metadata": {
      "width": 1920,
      "height": 1080,
      "duration": 120.5,
      "aspectRatio": "landscape",
      "resolutions": [
        { "width": 854, "height": 480, "bitrate": 800000 },
        { "width": 1280, "height": 720, "bitrate": 1200000 },
        { "width": 1920, "height": 1080, "bitrate": 2000000 }
      ]
    },
    "processingTime": 45230,
    "masterPlaylist": "converted/user-123/video-456/hls/master.m3u8"
  }
}
```

### 2. Validate Video

**POST** `/api/validate`

Validate a video file without processing it.

**Request:**
- Content-Type: `multipart/form-data`
- Body:
  - `video` (file): Video file

**Example:**
```bash
curl -X POST http://localhost:3000/api/validate \
  -F "video=@/path/to/video.mp4"
```

**Response:**
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

### 3. Get Video Metadata

**POST** `/api/metadata`

Get metadata for a video stored in Supabase Storage.

**Request:**
```json
{
  "videoPath": "Videos/video.mp4",
  "bucket": "videos"
}
```

**Example:**
```bash
curl -X POST http://localhost:3000/api/metadata \
  -H "Content-Type: application/json" \
  -d '{"videoPath":"Videos/video.mp4","bucket":"videos"}'
```

**Response:**
```json
{
  "success": true,
  "metadata": {
    "width": 1920,
    "height": 1080,
    "duration": 120.5,
    "aspectRatio": "landscape",
    "bitrate": 5000000
  }
}
```

### 4. Process from Storage

**POST** `/api/process-from-storage`

Process a video that's already in Supabase Storage.

**Request:**
```json
{
  "videoPath": "Videos/video.mp4",
  "bucket": "videos",
  "userId": "user-123",
  "videoId": "video-456"
}
```

**Example:**
```bash
curl -X POST http://localhost:3000/api/process-from-storage \
  -H "Content-Type: application/json" \
  -d '{
    "videoPath":"Videos/video.mp4",
    "bucket":"videos",
    "userId":"user-123",
    "videoId":"video-456"
  }'
```

**Response:**
```json
{
  "success": true,
  "message": "Video processed successfully",
  "data": {
    "outputFiles": [...],
    "metadata": {...},
    "processingTime": 45230,
    "masterPlaylist": "converted/user-123/video-456/hls/master.m3u8"
  }
}
```

### 5. Get Server Info

**GET** `/api/info`

Get information about supported formats and configuration.

**Example:**
```bash
curl http://localhost:3000/api/info
```

**Response:**
```json
{
  "success": true,
  "info": {
    "supportedFormats": ["mp4", "mov", "avi", "webm", "mkv"],
    "maxFileSize": "500MB",
    "resolutionSets": {
      "portrait": [...],
      "landscape": [...],
      "square": [...]
    },
    "storage": {
      "bucket": "hls-videos",
      "folder": "converted"
    }
  }
}
```

### 6. Health Check

**GET** `/health`

Check if the server is running.

**Example:**
```bash
curl http://localhost:3000/health
```

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

## Frontend Integration

### React Example

```typescript
import { useState } from 'react';

function VideoUpload() {
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);

  const handleUpload = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setUploading(true);

    const formData = new FormData(e.currentTarget);
    
    try {
      const response = await fetch('http://localhost:3000/api/upload', {
        method: 'POST',
        body: formData
      });

      const data = await response.json();
      setResult(data);

      if (data.success) {
        console.log('Video processed:', data.data.masterPlaylist);
      }
    } catch (error) {
      console.error('Upload failed:', error);
    } finally {
      setUploading(false);
    }
  };

  return (
    <form onSubmit={handleUpload}>
      <input type="file" name="video" accept="video/*" required />
      <input type="text" name="userId" placeholder="User ID" />
      <input type="text" name="videoId" placeholder="Video ID" />
      <button type="submit" disabled={uploading}>
        {uploading ? 'Processing...' : 'Upload Video'}
      </button>
      
      {result && (
        <div>
          <h3>Result:</h3>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
    </form>
  );
}
```

### Next.js App Router Example

```typescript
// app/upload/page.tsx
'use client';

import { useState } from 'react';

export default function UploadPage() {
  const [status, setStatus] = useState('');

  const handleUpload = async (formData: FormData) => {
    setStatus('Uploading...');

    const response = await fetch('http://localhost:3000/api/upload', {
      method: 'POST',
      body: formData
    });

    const result = await response.json();

    if (result.success) {
      setStatus(`Success! Master playlist: ${result.data.masterPlaylist}`);
    } else {
      setStatus(`Error: ${result.error}`);
    }
  };

  return (
    <div>
      <h1>Upload Video</h1>
      <form action={handleUpload}>
        <input type="file" name="video" accept="video/*" required />
        <button type="submit">Upload</button>
      </form>
      {status && <p>{status}</p>}
    </div>
  );
}
```

## Playing Processed Videos

After processing, use the master playlist URL with any HLS player:

### video.js

```html
<link href="https://vjs.zencdn.net/8.6.1/video-js.css" rel="stylesheet" />
<script src="https://vjs.zencdn.net/8.6.1/video.min.js"></script>

<video
  id="my-video"
  class="video-js"
  controls
  preload="auto"
  width="640"
  height="360"
>
  <source
    src="https://your-project.supabase.co/storage/v1/object/public/hls-videos/converted/user-123/video-456/hls/master.m3u8"
    type="application/x-mpegURL"
  />
</video>

<script>
  const player = videojs('my-video');
</script>
```

### hls.js (React)

```typescript
import Hls from 'hls.js';
import { useEffect, useRef } from 'react';

function VideoPlayer({ playlistUrl }: { playlistUrl: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!videoRef.current) return;

    if (Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(playlistUrl);
      hls.attachMedia(videoRef.current);
    } else if (videoRef.current.canPlayType('application/vnd.apple.mpegurl')) {
      videoRef.current.src = playlistUrl;
    }
  }, [playlistUrl]);

  return <video ref={videoRef} controls width="100%" />;
}
```

## Error Handling

All endpoints return consistent error responses:

```json
{
  "success": false,
  "error": "Error message here"
}
```

Common errors:

- **400 Bad Request**: Missing or invalid parameters
- **500 Internal Server Error**: Processing failed

## Resolution Ladders

The server automatically generates appropriate resolutions:

### Portrait (9:16) - TikTok, Instagram Stories
- 360×640 @ 400kbps
- 480×854 @ 800kbps
- 720×1280 @ 1.2Mbps
- 1080×1920 @ 2Mbps

### Landscape (16:9) - YouTube, Traditional
- 640×360 @ 400kbps
- 854×480 @ 800kbps
- 1280×720 @ 1.2Mbps
- 1920×1080 @ 2Mbps

### Square (1:1) - Instagram Posts
- 360×360 @ 400kbps
- 480×480 @ 800kbps
- 720×720 @ 1.2Mbps
- 1080×1080 @ 2Mbps

Only resolutions ≤ source resolution are generated.

## Storage Structure

Videos are organized in Supabase Storage:

```
{targetFolder}/
  {filename}/
    hls/
      master.m3u8        # Master playlist
      720p.m3u8          # 720p variant playlist
      480p.m3u8          # 480p variant playlist
      720p_000.ts        # Video segments
      720p_001.ts
      480p_000.ts
      480p_001.ts
      ...
```

Example: `converted/1736606618523/hls/master.m3u8`

## Performance Tips

1. **Concurrent Processing**: Adjust `MAX_CONCURRENT_JOBS` in `.env`
2. **Temp Directory**: Use fast storage (SSD) for temp files
3. **File Size Limit**: Adjust in `src/server.ts` (default 500MB)
4. **Memory**: Ensure sufficient RAM for video processing
5. **CDN**: Use Supabase CDN for serving HLS files

## Production Deployment

### Docker

Create `Dockerfile`:

```dockerfile
FROM node:18-alpine

# Install FFmpeg
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["npm", "run", "server:prod"]
```

Build and run:

```bash
docker build -t video-processor .
docker run -p 3000:3000 --env-file .env video-processor
```

### Environment Variables

```bash
# Production .env
NODE_ENV=production
PORT=3000
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
TARGET_BUCKET=hls-videos
TARGET_FOLDER=converted
TEMP_DIR=/tmp
MAX_CONCURRENT_JOBS=3
```

### Nginx Reverse Proxy

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    client_max_body_size 500M;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
    }
}
```

## Monitoring

Add logging and monitoring:

```typescript
// Example with custom logger
import { logger } from './utils/logger';

app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});
```

## Troubleshooting

### FFmpeg Not Found

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install ffmpeg

# macOS
brew install ffmpeg

# Alpine Linux (Docker)
apk add ffmpeg
```

### Out of Memory

Increase Node.js memory:

```bash
NODE_OPTIONS="--max-old-space-size=4096" npm run server
```

### Slow Processing

- Check CPU usage
- Reduce concurrent jobs
- Use faster storage for temp files
- Consider dedicated video processing server

## License

MIT

