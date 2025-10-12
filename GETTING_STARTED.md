# Getting Started

Quick setup guide to get your video processing server running.

## Prerequisites

1. **Node.js 18+**
   ```bash
   node --version  # Should be 18 or higher
   ```

2. **FFmpeg**
   ```bash
   ffmpeg -version  # Should show FFmpeg installed
   ```

   If not installed:
   - **Ubuntu/Debian**: `sudo apt-get install ffmpeg`
   - **macOS**: `brew install ffmpeg`
   - **Windows**: Download from https://ffmpeg.org/download.html

3. **Supabase Project**
   - Create a project at https://supabase.com
   - Note your project URL and anon key

## Installation

### 1. Install Dependencies

```bash
npm install
```

This will install:
- express, multer, cors (server)
- @supabase/supabase-js (storage)
- fluent-ffmpeg (video processing)
- winston (logging)
- And development dependencies

### 2. Create Environment File

Create a `.env` file in the root directory:

```bash
# Copy from example
cp .env.example .env

# Or create manually
cat > .env << 'EOF'
# Supabase Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key-here

# Storage Buckets
SOURCE_BUCKET=videos
SOURCE_FOLDER=Videos
TARGET_BUCKET=hls-videos
TARGET_FOLDER=converted

# Server Configuration
PORT=3000

# Processing Settings
MAX_CONCURRENT_JOBS=3
TEMP_DIR=./temp

# HLS Settings (optional)
HLS_SEGMENT_DURATION=6
HLS_PLAYLIST_TYPE=vod
EOF
```

### 3. Set Up Supabase Storage

In your Supabase project dashboard:

1. Go to **Storage**
2. Create two buckets:
   - `videos` (for source MP4 files) - can be private
   - `hls-videos` (for converted HLS files) - should be public

3. Set bucket policies:
   ```sql
   -- For hls-videos bucket (public read)
   CREATE POLICY "Public Access"
   ON storage.objects FOR SELECT
   USING (bucket_id = 'hls-videos');
   ```

### 4. Test Installation

```bash
# Test FFmpeg
ffmpeg -version

# Test TypeScript compilation
npm run build

# Test server
npm run server
```

You should see:
```
🚀 Video processing server running on port 3000
📁 Storage: hls-videos/converted
🎬 FFmpeg ready for video processing
```

### 5. Test Upload

Open `http://localhost:3000/health` in your browser.

You should see:
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

Or test with the upload page:
```bash
# Open in browser
open examples/upload-test.html
```

## Usage

### Start the Server

**Development:**
```bash
npm run server
```

**Production:**
```bash
npm run build
npm run server:prod
```

### Upload a Video

**Using cURL:**
```bash
curl -X POST http://localhost:3000/api/upload \
  -F "video=@path/to/video.mp4" \
  -F "userId=user-123"
```

**Using the test page:**
1. Open `examples/upload-test.html` in browser
2. Drag and drop a video
3. Click "Upload & Process"

**Using JavaScript:**
```javascript
const formData = new FormData();
formData.append('video', fileInput.files[0]);
formData.append('userId', 'user-123');

const response = await fetch('http://localhost:3000/api/upload', {
  method: 'POST',
  body: formData
});

const result = await response.json();
console.log(result);
```

### Run Batch Migration

If you have existing videos in Supabase Storage:

```bash
# Preview what will be processed
npm run migrate -- --dry-run

# Process first 5 videos (testing)
npm run migrate -- --limit 5

# Process all videos
npm run migrate
```

## Verify Output

After processing, check your Supabase Storage:

1. Go to Supabase Dashboard → Storage → `hls-videos`
2. Navigate to `converted/{userId}/{videoId}/hls/`
3. You should see:
   - `master.m3u8` - Master playlist
   - `720p.m3u8`, `480p.m3u8` - Quality variants
   - `720p_000.ts`, `720p_001.ts` - Video segments

## Play the Video

Get the master playlist URL:
```
https://YOUR_PROJECT.supabase.co/storage/v1/object/public/hls-videos/converted/user-123/video-456/hls/master.m3u8
```

Test in browser (Safari/iOS support HLS natively):
```html
<video controls width="640">
  <source src="YOUR_PLAYLIST_URL" type="application/x-mpegURL">
</video>
```

Or use a player library (video.js, hls.js) - see README.md

## Common Issues

### "Cannot find module 'express'"

```bash
# Install dependencies
npm install
```

### "FFmpeg not found"

```bash
# Check installation
ffmpeg -version

# If not installed:
# Ubuntu/Debian
sudo apt-get update && sudo apt-get install ffmpeg

# macOS
brew install ffmpeg
```

### "Invalid Supabase credentials"

Check your `.env` file:
- SUPABASE_URL should start with `https://`
- SUPABASE_ANON_KEY should be your anon/public key
- Test credentials in Supabase dashboard

### "Storage bucket not found"

1. Go to Supabase Dashboard → Storage
2. Create the buckets specified in your `.env`:
   - `hls-videos` (public)
   - `videos` (can be private)

### Port 3000 already in use

Change port in `.env`:
```bash
PORT=3001
```

## Next Steps

1. ✅ Server is running
2. ✅ Test upload works
3. 📖 Read [SERVER_GUIDE.md](./SERVER_GUIDE.md) for API documentation
4. 🔧 Customize resolution settings in `src/config/index.ts`
5. 🚀 Deploy to production (see README.md Docker section)

## Development Workflow

```bash
# 1. Make changes to src/server.ts or other files

# 2. Run in dev mode (auto-restart on changes)
npm run server

# 3. Test with upload page
open examples/upload-test.html

# 4. Build for production
npm run build

# 5. Test production build
npm run server:prod
```

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUPABASE_URL` | ✅ Yes | - | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | ✅ Yes | - | Your Supabase anon key |
| `SOURCE_BUCKET` | No | `videos` | Source video bucket |
| `SOURCE_FOLDER` | No | `Videos` | Source folder in bucket |
| `TARGET_BUCKET` | No | `hls-videos` | Output HLS bucket |
| `TARGET_FOLDER` | No | `converted` | Output folder in bucket |
| `PORT` | No | `3000` | Server port |
| `MAX_CONCURRENT_JOBS` | No | `3` | Max parallel conversions |
| `TEMP_DIR` | No | `./temp` | Temporary file directory |
| `HLS_SEGMENT_DURATION` | No | `6` | HLS segment length (seconds) |
| `HLS_PLAYLIST_TYPE` | No | `vod` | HLS playlist type |

## Support

- 📖 Full documentation: [SERVER_GUIDE.md](./SERVER_GUIDE.md)
- 🐛 Issues: Open an issue on GitHub
- 💬 Questions: Check existing issues or create new one

---

**Ready to process videos! 🎬**

