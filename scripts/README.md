# Admin Scripts

This directory contains administrative scripts for managing video processing.

## sync-hls-urls.ts

Traverses all HLS files in Supabase Storage and updates corresponding posts with their HLS master playlist URLs.

### How It Works

1. **Scans Storage** - Lists all `master.m3u8` files in the HLS storage folder
2. **Extracts Filename** - Gets the original video filename from the path
   - Example: `converted/1736606618523/hls/master.m3u8` → `1736606618523.mp4`
3. **Finds Posts** - Searches for posts where `video_url` contains the filename
4. **Updates Posts** - Sets the `hls_url` field to the full public HLS URL

### Usage

**Preview changes (dry run):**
```bash
npm run sync-hls-urls -- --dry-run
```

**Apply changes:**
```bash
npm run sync-hls-urls
```

**Help:**
```bash
npm run sync-hls-urls -- --help
```

### Example Output

```
🚀 Starting HLS URL sync...

📁 Scanning bucket: FlutterFlow/converted
✅ Found 15 HLS master playlists

📊 Processing HLS files...

🔍 Processing: 1736606618523.mp4
   HLS Path: converted/1736606618523/hls/master.m3u8
   ✅ Found post: abc123
   📹 Video URL: https://ohfzckfunpsjncjjzfyz.supabase.co/storage/v1/object/public/FlutterFlow/Videos/1736606618523.mp4
   🎬 HLS URL: https://ohfzckfunpsjncjjzfyz.supabase.co/storage/v1/object/public/FlutterFlow/converted/1736606618523/hls/master.m3u8
   ✅ Updated post abc123

============================================================
📊 SYNC SUMMARY
============================================================

📁 Total HLS files found: 15
🔍 Posts found: 15
✅ Posts updated: 15
⏭️  Skipped: 0
❌ Errors: 0

============================================================

🎉 Sync completed!
```

### Configuration

The script uses these environment variables:

```bash
# Required
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key

# Optional
TARGET_BUCKET=FlutterFlow
TARGET_FOLDER=converted
PUBLIC_STORAGE_BASE_URL=https://ohfzckfunpsjncjjzfyz.supabase.co/storage/v1/object/public/FlutterFlow/
```

### When to Use

- After manually uploading HLS files to storage
- After migrating videos from another system
- To fix missing or incorrect `hls_url` values
- To backfill HLS URLs for existing posts

### Requirements

1. **Posts table** must have:
   - `id` field (primary key)
   - `video_url` field (contains original MP4 URL)
   - `hls_url` field (will be updated with HLS URL)

2. **Storage structure**:
   ```
   FlutterFlow/
     converted/
       {filename}/
         hls/
           master.m3u8
           720p.m3u8
           ...
   ```

3. **Filename matching**:
   - The `{filename}` in the path should match the filename in `video_url`
   - Example: `converted/1736606618523/hls/master.m3u8` matches posts where `video_url` contains `1736606618523.mp4`

### Troubleshooting

**No HLS files found:**
- Check `TARGET_BUCKET` and `TARGET_FOLDER` in `.env`
- Verify HLS files exist in storage
- Ensure `master.m3u8` files are present

**No posts found:**
- Verify posts table has `video_url` field
- Check that `video_url` contains the video filename
- Use `--dry-run` to see what the script is looking for

**Update failed:**
- Check Supabase permissions
- Verify `hls_url` column exists in posts table
- Check the error message for details

### Advanced Usage

**Programmatic usage:**
```typescript
import { syncHlsUrls, findPostByVideoUrl, updatePostHlsUrl } from './scripts/sync-hls-urls';

// Run full sync
const result = await syncHlsUrls(false); // false = not dry run

// Find specific post
const post = await findPostByVideoUrl('1736606618523.mp4');

// Update specific post
await updatePostHlsUrl('post-id', 'https://.../master.m3u8');
```

### Safety

- **Always run `--dry-run` first** to preview changes
- Script only updates `hls_url` field, doesn't modify other data
- Skips posts that already have the correct HLS URL
- Logs all actions for audit trail
- No destructive operations

### Performance

- Processes files sequentially (not concurrent)
- Typical speed: ~1-2 posts per second
- For large datasets (1000+ posts), consider running in stages
- No database load issues (single record updates)

