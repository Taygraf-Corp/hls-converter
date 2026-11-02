import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import { FFmpegService } from './services/ffmpeg.js';
import { SupabaseStorageService } from './services/supabase.js';
import { VideoFile, ConversionOptions } from './types/index.js';
import { logger } from './utils/logger.js';
import { ensureDir, cleanup, generateTempDir, getFilenameWithoutExtension } from './utils/file-utils.js';
import { migrationConfig, resolutionSets } from './config/index.js';
import { authenticate, isAuthEnabled } from './middleware/auth.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files from examples directory
app.use('/examples', express.static(path.join(process.cwd(), 'examples')));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: async (_req: any, _file: any, cb: any) => {
    const uploadDir = path.join(migrationConfig.processing.tempDir, 'uploads');
    await ensureDir(uploadDir);
    cb(null, uploadDir);
  },
  filename: (_req: any, file: any, cb: any) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    cb(null, `${uniqueSuffix}-${file.originalname}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB max file size
  },
  fileFilter: (_req: any, file: any, cb: any) => {
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'));
    }
  }
});

// Services
const ffmpegService = new FFmpegService();
const storageService = new SupabaseStorageService();
const supabase = new SupabaseStorageService();

/**
 * Process video and convert to HLS
 */
async function processVideo(
  inputPath: string,
  filename: string,
  options?: {
    userId?: string;
    videoId?: string;
    customPath?: string;
    postId?: string;
  }
): Promise<{
  success: boolean;
  outputFiles?: string[];
  metadata?: any;
  error?: string;
  processingTime?: number;
}> {
  const startTime = Date.now();
  let tempDir: string | null = null;

  try {
    logger.info(`Processing video: ${filename}`);

    // Validate video
    const isValid = await ffmpegService.validateVideo(inputPath);
    if (!isValid) {
      throw new Error('Invalid video file');
    }

    // Get metadata and create smart conversion options
    const metadata = await ffmpegService.getVideoMetadata(inputPath);
    const baseOptions: ConversionOptions = {
      ...migrationConfig.hls,
      resolutions: resolutionSets[metadata.aspectRatio]
    };

    const smartOptions = await ffmpegService.createSmartConversionOptions(
      inputPath,
      baseOptions
    );

    logger.info(
      `Video: ${metadata.width}x${metadata.height}, ` +
      `${metadata.aspectRatio}, ${metadata.duration.toFixed(2)}s, ` +
      `${smartOptions.resolutions.length} resolution(s)`
    );

    // Create temp output directory
    const baseFilename = getFilenameWithoutExtension(filename);
    tempDir = generateTempDir(
      migrationConfig.processing.tempDir,
      `process-${baseFilename}`
    );
    await ensureDir(tempDir);

    const outputDir = path.join(tempDir, 'hls');

    // Convert to HLS
    logger.info(`Converting to HLS...`);
    const outputFiles = await ffmpegService.convertToHls(
      inputPath,
      outputDir,
      smartOptions,
      (progress) => {
        logger.debug(`Conversion progress: ${progress.toFixed(1)}%`);
      }
    );

    // Determine storage path
    const storagePath = options?.customPath || buildStoragePath(
      baseFilename,
      options?.videoId
    );

    // Upload to Supabase Storage
    logger.info(`Uploading to storage: ${storagePath}`);
    const uploadedFiles = await storageService.uploadHlsFiles(
      outputDir,
      storagePath
    );

    // Update post with HLS URL if postId provided
    const postId = options?.postId;
    if (postId) {
      try {
        // Construct full public HLS URL
        const baseStorageUrl = process.env.PUBLIC_STORAGE_BASE_URL || 
          'https://ohfzckfunpsjncjjzfyz.supabase.co/storage/v1/object/public/FlutterFlow/';
        const masterPlaylistPath = uploadedFiles.find(f => f.endsWith('master.m3u8'));
        
        if (masterPlaylistPath) {
          const hlsUrl = `${baseStorageUrl}${masterPlaylistPath}`;
          logger.info(`Updating post ${postId} with HLS URL: ${hlsUrl}`);
          
          await supabase.updatePost(postId, {
            hls_url: hlsUrl
          });
        }
      } catch (error) {
        logger.error(`Error updating post ${postId}:`, error);
      }
    }

    const processingTime = Date.now() - startTime;

    logger.info(
      `Successfully processed ${filename}: ` +
      `${uploadedFiles.length} files in ${(processingTime / 1000).toFixed(2)}s`
    );

    // Cleanup
    await cleanup([tempDir]);

    return {
      success: true,
      outputFiles: uploadedFiles,
      metadata: {
        width: metadata.width,
        height: metadata.height,
        duration: metadata.duration,
        aspectRatio: metadata.aspectRatio,
        resolutions: smartOptions.resolutions
      },
      processingTime
    };

  } catch (error) {
    const processingTime = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    logger.error(`Processing failed: ${errorMessage}`, error);

    // Cleanup on error
    if (tempDir) {
      await cleanup([tempDir]).catch(err => 
        logger.warn('Failed to cleanup temp files:', err)
      );
    }

    return {
      success: false,
      error: errorMessage,
      processingTime
    };
  }
}

/** Public source bucket: legacy Standard posts and multi-account uploads. */
const PUBLIC_SOURCE_BUCKET = 'FlutterFlow';
/** Private bucket of the unified composer (taygram #101). */
const PRIVATE_SOURCE_BUCKET = 'unfiltered';

/**
 * Decide whether a source object may be converted. HLS output always lands in
 * the public bucket, so a private object may only be converted when it is the
 * media of a single-item post shown in the General Feed only (channel
 * 'standard'). A post that is also in Unfiltered keeps its media private.
 * Returns a refusal reason, or null when the request is allowed.
 */
async function checkSourceAllowed(
  bucket: string,
  videoPath: string,
  postId?: string,
  videoId?: string
): Promise<string | null> {
  if (bucket === PUBLIC_SOURCE_BUCKET) {
    // A public file may be converted, but it may only be written onto the post
    // whose own video it is.
    if (!postId) {
      return null;
    }
    const post = await storageService.getPostMedia(postId);
    if (!post) {
      return 'post not found';
    }
    if (!sameObject(post.video_url, bucket, videoPath)) {
      return 'videoPath is not this post\'s video';
    }
    return null;
  }
  if (bucket !== PRIVATE_SOURCE_BUCKET) {
    return `bucket ${bucket} is not a conversion source`;
  }
  if (!postId || (videoId && videoId !== postId)) {
    return 'private media needs a postId, and videoId must equal it';
  }
  const post = await storageService.getPostMedia(postId);
  if (!post) {
    return 'post not found';
  }
  if (post.media_bucket !== bucket || post.media_path !== videoPath) {
    return 'videoPath is not this post\'s media';
  }
  if (post.in_general_feed !== true || post.channel !== 'standard') {
    return 'only General Feed-only posts are converted; Unfiltered media stays private';
  }
  if ((post.media_count ?? 1) !== 1) {
    return 'carousel posts are not converted';
  }
  return null;
}

/** Whether a public object URL names bucket/objectPath (URL-encoding ignored). */
function sameObject(url: string | null, bucket: string, objectPath: string): boolean {
  if (!url) {
    return false;
  }
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    return pathname.endsWith(`/storage/v1/object/public/${bucket}/${objectPath}`);
  } catch {
    return false;
  }
}

/**
 * Build storage path
 * Structure: converted/{filename}/hls
 */
function buildStoragePath(
  filename: string,
  videoId?: string
): string {
  const parts = [migrationConfig.storage.targetFolder];

  // Use videoId if provided, otherwise sanitize filename
  const id = videoId || sanitizeFilename(filename);
  parts.push(id, 'hls');

  return parts.join('/');
}

/**
 * Sanitize filename
 */
function sanitizeFilename(filename: string): string {
  return filename
    .replace(/\.[^/.]+$/, '')
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase();
}

// Routes

/**
 * Home page - Upload test interface
 */
app.get('/', (req: Request, res: Response) => {
  res.sendFile(path.join(process.cwd(), 'examples', 'upload-test.html'));
});

/**
 * Health check
 */
app.get('/health', (req: Request, res: Response) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

/**
 * Upload and process video
 */
app.post('/api/upload', authenticate, upload.single('video'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No video file provided'
      });
    }

    logger.info(`Received upload: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)} MB)`);

    const { userId, videoId, postId } = req.body;

    // Process the video
    const result = await processVideo(
      req.file.path,
      req.file.originalname,
      { userId, videoId, postId }
    );

    // Cleanup uploaded file
    await cleanup([req.file.path]);

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error
      });
    }

    res.json({
      success: true,
      message: 'Video processed successfully',
      data: {
        outputFiles: result.outputFiles,
        metadata: result.metadata,
        processingTime: result.processingTime,
        masterPlaylist: result.outputFiles?.find(f => f.endsWith('master.m3u8'))
      }
    });

  } catch (error) {
    logger.error('Upload error:', error);
    
    // Cleanup uploaded file on error
    if (req.file) {
      await cleanup([req.file.path]).catch(() => {});
    }

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Upload failed'
    });
  }
});

/**
 * Validate video without processing
 */
app.post('/api/validate', authenticate, upload.single('video'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No video file provided'
      });
    }

    logger.info(`Validating: ${req.file.originalname}`);

    const isValid = await ffmpegService.validateVideo(req.file.path);
    
    if (!isValid) {
      await cleanup([req.file.path]);
      return res.status(400).json({
        success: false,
        valid: false,
        error: 'Invalid or corrupted video file'
      });
    }

    const metadata = await ffmpegService.getVideoMetadata(req.file.path);
    
    // Cleanup
    await cleanup([req.file.path]);

    res.json({
      success: true,
      valid: true,
      metadata: {
        width: metadata.width,
        height: metadata.height,
        duration: metadata.duration,
        aspectRatio: metadata.aspectRatio,
        bitrate: metadata.bitrate
      }
    });

  } catch (error) {
    logger.error('Validation error:', error);
    
    if (req.file) {
      await cleanup([req.file.path]).catch(() => {});
    }

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Validation failed'
    });
  }
});

/**
 * Get video metadata from URL
 */
app.post('/api/metadata', authenticate, express.json(), async (req: Request, res: Response) => {
  try {
    const { videoPath, bucket } = req.body;

    if (!videoPath) {
      return res.status(400).json({
        success: false,
        error: 'videoPath is required'
      });
    }

    const videoFile: VideoFile = {
      name: path.basename(videoPath),
      path: videoPath,
      size: 0,
      bucket: bucket || migrationConfig.storage.sourceBucket
    };

    // Download video temporarily
    const tempDir = generateTempDir(migrationConfig.processing.tempDir, 'metadata');
    await ensureDir(tempDir);
    const tempPath = path.join(tempDir, videoFile.name);

    await storageService.downloadFile(videoFile, tempPath);

    const metadata = await ffmpegService.getVideoMetadata(tempPath);

    // Cleanup
    await cleanup([tempDir]);

    res.json({
      success: true,
      metadata: {
        width: metadata.width,
        height: metadata.height,
        duration: metadata.duration,
        aspectRatio: metadata.aspectRatio,
        bitrate: metadata.bitrate
      }
    });

  } catch (error) {
    logger.error('Metadata error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get metadata'
    });
  }
});

/**
 * Process video from storage
 */
app.post('/api/process-from-storage', authenticate, express.json(), async (req: Request, res: Response) => {
  try {
    const { videoPath, bucket, userId, videoId, postId } = req.body;

    if (!videoPath) {
      return res.status(400).json({
        success: false,
        error: 'videoPath is required'
      });
    }

    const videoFile: VideoFile = {
      name: path.basename(videoPath),
      path: videoPath,
      size: 0,
      bucket: bucket || migrationConfig.storage.sourceBucket
    };

    const refusal = await checkSourceAllowed(videoFile.bucket, videoPath, postId, videoId);
    if (refusal) {
      logger.warn(`Refused process-from-storage for ${videoFile.bucket}/${videoPath}: ${refusal}`);
      return res.status(403).json({ success: false, error: refusal });
    }

    logger.info(`Processing from storage: ${videoPath}`);

    // Download video
    const tempDir = generateTempDir(migrationConfig.processing.tempDir, 'storage-process');
    await ensureDir(tempDir);
    const tempPath = path.join(tempDir, videoFile.name);

    await storageService.downloadFile(videoFile, tempPath);

    // Process the video
    const result = await processVideo(tempPath, videoFile.name, { userId, videoId, postId });

    // Cleanup
    await cleanup([tempDir]);

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error
      });
    }

    res.json({
      success: true,
      message: 'Video processed successfully',
      data: {
        outputFiles: result.outputFiles,
        metadata: result.metadata,
        processingTime: result.processingTime,
        masterPlaylist: result.outputFiles?.find(f => f.endsWith('master.m3u8'))
      }
    });

  } catch (error) {
    logger.error('Process from storage error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Processing failed'
    });
  }
});

/**
 * Get processing status/info
 */
app.get('/api/info', (req: Request, res: Response) => {
  res.json({
    success: true,
    info: {
      supportedFormats: ['mp4', 'mov', 'avi', 'webm', 'mkv'],
      maxFileSize: '500MB',
      resolutionSets: {
        portrait: resolutionSets.portrait,
        landscape: resolutionSets.landscape,
        square: resolutionSets.square
      },
      storage: {
        bucket: migrationConfig.storage.targetBucket,
        folder: migrationConfig.storage.targetFolder
      }
    }
  });
});

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error('Server error:', err);
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'File too large. Maximum size is 500MB'
      });
    }
  }

  res.status(500).json({
    success: false,
    error: err.message || 'Internal server error'
  });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'Route not found'
  });
});

// Start server
app.listen(PORT, () => {
  logger.info(`🚀 Video processing server running on port ${PORT}`);
  logger.info(`📁 Storage: ${migrationConfig.storage.targetBucket}/${migrationConfig.storage.targetFolder}`);
  logger.info(`🎬 FFmpeg ready for video processing`);
  
  if (isAuthEnabled()) {
    logger.info(`🔐 API key authentication: ENABLED`);
  } else {
    logger.warn(`⚠️  API key authentication: DISABLED (set API_KEYS env variable to enable)`);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully...');
  process.exit(0);
});

export default app;

