# Taygram Video Migration & Processing

A complete solution for converting MP4 videos to HLS format with adaptive streaming. Includes both batch migration tools and an Express API server for real-time video processing.

## Features

- 🎬 **Smart Video Processing** - Automatic aspect ratio detection (portrait, landscape, square)
- 📱 **Adaptive Streaming** - Multiple quality levels for optimal playback
- 🚀 **Express API Server** - REST API for video uploads and processing
- 📦 **Batch Migration** - CLI tool for migrating existing video libraries
- ☁️ **Supabase Integration** - Direct storage integration
- 🔧 **FFmpeg Powered** - Professional video encoding

## Quick Start

### 1. Install

```bash
git clone <your-repo>
cd taygram-video-migration
npm install
```

### 2. Configure

Create `.env` file:

```bash
# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key

# Storage
SOURCE_BUCKET=videos
SOURCE_FOLDER=Videos
TARGET_BUCKET=hls-videos
TARGET_FOLDER=converted

# Server (optional)
PORT=3000

# Processing
MAX_CONCURRENT_JOBS=3
TEMP_DIR=./temp
```

### 3. Run

**Option A: API Server (for uploads)**
```bash
npm run server
```

**Option B: Batch Migration (for existing videos)**
```bash
npm run migrate
```

## Use Cases

### 1. Real-Time Video Upload Processing

Use the Express server to handle video uploads from your app:

```bash
npm run server
```

Then upload videos via the REST API:

```bash
curl -X POST http://localhost:3000/api/upload \
  -F "video=@video.mp4" \
  -F "userId=user-123"
```

See [SERVER_GUIDE.md](./SERVER_GUIDE.md) for complete API documentation.

### 2. Batch Migration of Existing Videos

Migrate all videos already in your Supabase storage:

```bash
npm run migrate
```

Options:
```bash
npm run migrate -- --format hls           # HLS only
npm run migrate -- --limit 10             # Process first 10 videos
npm run migrate -- --dry-run              # Preview what will be processed
npm run migrate -- --retry-failed         # Retry failed videos
```

### 3. Sync HLS URLs to Posts

After processing videos, update your posts table with HLS URLs:

```bash
# Preview what will be updated
npm run sync-hls-urls -- --dry-run

# Apply updates
npm run sync-hls-urls
```

The script automatically:
- Finds all HLS files in storage
- Matches them to posts by video filename
- Updates posts with the full HLS URL

See [scripts/README.md](./scripts/README.md) for more details.

## Project Structure

```
taygram-video-migration/
├── src/
│   ├── server.ts              # Express API server
│   ├── migrate.ts             # CLI migration tool
│   ├── services/
│   │   ├── ffmpeg.ts          # FFmpeg video processing
│   │   ├── supabase.ts        # Supabase storage
│   │   └── migration.ts       # Batch migration logic
│   ├── config/
│   │   └── index.ts           # Configuration
│   └── utils/
│       ├── logger.ts          # Logging
│       └── file-utils.ts      # File operations
├── scripts/
│   ├── sync-hls-urls.ts       # Sync HLS URLs to posts
│   └── README.md              # Scripts documentation
├── examples/
│   └── upload-test.html       # Test upload page
├── SERVER_GUIDE.md            # API documentation
└── README.md                  # This file
```

## API Server

### Endpoints

- `POST /api/upload` - Upload and process video
- `POST /api/validate` - Validate video without processing
- `POST /api/metadata` - Get video metadata
- `POST /api/process-from-storage` - Process existing storage video
- `GET /api/info` - Get server configuration
- `GET /health` - Health check

### Example Usage

```javascript
const formData = new FormData();
formData.append('video', videoFile);
formData.append('userId', 'user-123');

const response = await fetch('http://localhost:3000/api/upload', {
  method: 'POST',
  body: formData
});

const result = await response.json();
if (result.success) {
  console.log('Master playlist:', result.data.masterPlaylist);
  console.log('Processing time:', result.data.processingTime);
}
```

### Test Upload Page

Open `examples/upload-test.html` in your browser for a visual upload interface.

## Resolution Ladders

Automatically generates appropriate resolutions based on video aspect ratio:

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

*Only resolutions ≤ source resolution are generated*

## Storage Structure

```
{targetFolder}/
  {filename}/
    hls/
      master.m3u8        # Master playlist
      720p.m3u8          # Quality variant
      480p.m3u8
      720p_000.ts        # Video segments
      720p_001.ts
      ...
```

Example: `converted/1736606618523/hls/master.m3u8`

## Playing Processed Videos

### Using video.js

```html
<link href="https://vjs.zencdn.net/8.6.1/video-js.css" rel="stylesheet" />
<script src="https://vjs.zencdn.net/8.6.1/video.min.js"></script>

<video id="my-video" class="video-js" controls>
  <source 
    src="https://your-project.supabase.co/storage/v1/object/public/hls-videos/converted/user-123/video-456/hls/master.m3u8"
    type="application/x-mpegURL"
  />
</video>

<script>
  videojs('my-video');
</script>
```

### Using hls.js

```javascript
import Hls from 'hls.js';

const video = document.getElementById('video');
const hls = new Hls();
hls.loadSource('https://.../master.m3u8');
hls.attachMedia(video);
```

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run server

# Build for production
npm run build

# Run built version
npm run server:prod

# Run migration
npm run migrate

# Run tests
npm test
```

## Docker Deployment

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

```bash
docker build -t video-processor .
docker run -p 3000:3000 --env-file .env video-processor
```

## Requirements

- Node.js 18+
- FFmpeg installed on system
- Supabase project with storage enabled

### Install FFmpeg

```bash
# Ubuntu/Debian
sudo apt-get update && sudo apt-get install ffmpeg

# macOS
brew install ffmpeg

# Alpine Linux (Docker)
apk add ffmpeg
```

## Performance

- **Small videos (<100MB)**: ~30-60 seconds
- **Medium videos (100-500MB)**: ~2-4 minutes
- **Large videos (>500MB)**: ~5-8 minutes

Processing time depends on:
- Video length and resolution
- Number of quality levels generated
- CPU performance
- Disk I/O speed

## Configuration

### Environment Variables

```bash
# Required
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key

# Storage Configuration
SOURCE_BUCKET=videos              # Source video bucket
SOURCE_FOLDER=Videos              # Source folder path
TARGET_BUCKET=hls-videos          # Output bucket
TARGET_FOLDER=converted           # Output folder

# Server Configuration
PORT=3000                         # API server port

# Processing Configuration
MAX_CONCURRENT_JOBS=3             # Concurrent video processing
TEMP_DIR=./temp                   # Temporary file directory

# HLS Configuration
HLS_SEGMENT_DURATION=6            # Segment duration (seconds)
HLS_PLAYLIST_TYPE=vod             # 'vod' or 'event'
```

## Troubleshooting

### FFmpeg not found
```bash
# Check FFmpeg installation
ffmpeg -version

# Install if missing (see Requirements section)
```

### Out of memory
```bash
# Increase Node.js memory
NODE_OPTIONS="--max-old-space-size=4096" npm run server
```

### Slow processing
- Reduce MAX_CONCURRENT_JOBS
- Use SSD for TEMP_DIR
- Check CPU usage
- Consider dedicated processing server

## Documentation

- [SERVER_GUIDE.md](./SERVER_GUIDE.md) - Complete API documentation
- [examples/](./examples/) - Code examples

## Architecture

### Services

- **FFmpegService**: Video encoding and metadata extraction
- **SupabaseStorageService**: File storage operations
- **VideoMigrationService**: Batch processing coordination

### Workflow

1. **Upload** - Video uploaded via API or already in storage
2. **Validate** - Check video integrity
3. **Analyze** - Extract metadata (resolution, aspect ratio, duration)
4. **Convert** - Generate HLS with multiple quality levels
5. **Upload** - Upload segments to Supabase Storage
6. **Cleanup** - Remove temporary files

## Testing

### Manual Testing

1. Start server: `npm run server`
2. Open `examples/upload-test.html`
3. Upload a video
4. Check response and generated files

### API Testing

```bash
# Health check
curl http://localhost:3000/health

# Upload video
curl -X POST http://localhost:3000/api/upload \
  -F "video=@test-video.mp4" \
  -F "userId=test-user"

# Validate video
curl -X POST http://localhost:3000/api/validate \
  -F "video=@test-video.mp4"
```

## Production Considerations

### Security
- Add authentication middleware
- Validate file types and sizes
- Rate limit uploads
- Sanitize user inputs

### Scaling
- Use message queue for async processing
- Deploy multiple worker instances
- Use CDN for HLS delivery
- Monitor disk space

### Monitoring
- Log all operations
- Track processing times
- Monitor error rates
- Alert on failures

## License

MIT

## Support

For issues, questions, or contributions, please open an issue or pull request.

---

**Built with ❤️ for Taygram**
