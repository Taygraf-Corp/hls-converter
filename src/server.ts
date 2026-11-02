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
import {
  PUBLIC_SOURCE_BUCKET,
  PostRow,
  conversionRefusal,
  hlsFolderFor,
  isUuid,
  revokeRequired,
} from './services/hls-policy.js';

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

/**
 * Process video and convert to HLS
 */
async function processVideo(
  inputPath: string,
  filename: string,
  storagePath: string
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

    // Upload to Supabase Storage
    logger.info(`Uploading to storage: ${storagePath}`);
    const uploadedFiles = await storageService.uploadHlsFiles(
      outputDir,
      storagePath
    );

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

const PUBLIC_STORAGE_BASE_URL = process.env.PUBLIC_STORAGE_BASE_URL ||
  'https://ohfzckfunpsjncjjzfyz.supabase.co/storage/v1/object/public/FlutterFlow/';

/**
 * Routes the app does not use (manual upload, validate, metadata, the test
 * page) stay off unless ENABLE_ADMIN_ROUTES=true: /api/upload used to write
 * hls_url onto any caller-named post (CTO review 2026-11-02, finding 1).
 */
const adminRoutesEnabled = process.env.ENABLE_ADMIN_ROUTES === 'true';
function adminOnly(_req: Request, res: Response, next: NextFunction): void {
  if (!adminRoutesEnabled) {
    res.status(404).json({ success: false, error: 'Route not found' });
    return;
  }
  next();
}

async function loadPolicyInputs(postId: string): Promise<{ post: PostRow | null; deletionPending: boolean }> {
  const post = await storageService.getPostForHls(postId);
  const deletionPending = post ? await storageService.hasDeletionJob(post.profile_id) : false;
  return { post, deletionPending };
}

// Routes

/**
 * Home page - Upload test interface
 */
app.get('/', adminOnly, (req: Request, res: Response) => {
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
app.post('/api/upload', adminOnly, authenticate, upload.single('video'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No video file provided'
      });
    }

    logger.info(`Received upload: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)} MB)`);

    // Admin-only test path: never bound to a post, never a caller-chosen folder.
    const result = await processVideo(
      req.file.path,
      req.file.originalname,
      `${migrationConfig.storage.targetFolder}/manual-${Date.now()}-${Math.round(Math.random() * 1e9)}/hls`
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
app.post('/api/validate', adminOnly, authenticate, upload.single('video'), async (req: Request, res: Response) => {
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
app.post('/api/metadata', adminOnly, authenticate, express.json(), async (req: Request, res: Response) => {
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
 * Convert one post's own video to HLS and set its hls_url.
 *
 * Body: { postId, videoPath, bucket?, videoId? }. postId is required; the
 * output folder is always converted/<postId>/hls, derived here, never taken
 * from the caller (CTO review finding 2). The post row decides whether the
 * source may be converted (hls-policy.ts); hls_url is set in one UPDATE that
 * rechecks eligibility, and on any refusal the uploaded files are removed.
 * 200 only when hls_url was written; 403 refused up front; 409 the post
 * changed during conversion; 500 failure (nothing left published).
 */
app.post('/api/process-from-storage', authenticate, express.json(), async (req: Request, res: Response) => {
  const { videoPath, bucket, videoId, postId } = req.body ?? {};
  if (typeof videoPath !== 'string' || !videoPath || videoPath.includes('..')) {
    return res.status(400).json({ success: false, error: 'videoPath is required' });
  }
  if (!isUuid(postId)) {
    return res.status(400).json({ success: false, error: 'postId (a UUID) is required' });
  }
  if (videoId !== undefined && videoId !== null && String(videoId).toLowerCase() !== postId.toLowerCase()) {
    return res.status(400).json({ success: false, error: 'videoId, when given, must equal postId' });
  }
  const sourceBucket: string = typeof bucket === 'string' && bucket ? bucket : PUBLIC_SOURCE_BUCKET;
  const folder = hlsFolderFor(postId, migrationConfig.storage.targetFolder);

  let tempDir: string | null = null;
  let uploaded: string[] = [];
  try {
    const before = await loadPolicyInputs(postId);
    const refusal = conversionRefusal(before.post, sourceBucket, videoPath, before.deletionPending);
    if (refusal || !before.post) {
      logger.warn(`Refused process-from-storage: ${refusal}`);
      return res.status(403).json({ success: false, error: refusal });
    }
    const post = before.post;
    if (await storageService.otherPostUsesFolder(postId, folder)) {
      logger.warn('Refused process-from-storage: another post plays from this folder');
      return res.status(409).json({ success: false, error: 'another post plays HLS from this folder' });
    }

    const videoFile: VideoFile = { name: path.basename(videoPath), path: videoPath, size: 0, bucket: sourceBucket };
    logger.info('Processing from storage');
    tempDir = generateTempDir(migrationConfig.processing.tempDir, 'storage-process');
    await ensureDir(tempDir);
    const tempPath = path.join(tempDir, videoFile.name);
    await storageService.downloadFile(videoFile, tempPath);

    const result = await processVideo(tempPath, videoFile.name, folder);
    uploaded = result.outputFiles ?? [];
    if (!result.success) {
      throw new Error(result.error || 'conversion failed');
    }
    const master = uploaded.find(f => f.endsWith('master.m3u8'));
    if (!master) {
      throw new Error('no master playlist was produced');
    }

    // Publication-time recheck: the row must still be eligible and name the
    // same source, in the same UPDATE that publishes the URL.
    const published = await storageService.setHlsUrlIfStillEligible(post, `${PUBLIC_STORAGE_BASE_URL}${master}`);
    if (!published) {
      await storageService.removeFolder(folder);
      uploaded = [];
      logger.warn('Post changed during conversion; HLS removed');
      return res.status(409).json({ success: false, error: 'post is no longer eligible; nothing published' });
    }

    logger.info('Successfully set hls_url');
    return res.json({
      success: true,
      message: 'Video processed successfully',
      data: {
        outputFiles: uploaded,
        metadata: result.metadata,
        processingTime: result.processingTime,
        masterPlaylist: master
      }
    });
  } catch (error) {
    logger.error('Process from storage error:', error);
    if (uploaded.length > 0) {
      // Never leave a public copy that no row points at.
      await storageService.removeFolder(folder).catch(err =>
        logger.error('Failed to remove HLS after an error:', err));
    }
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Processing failed'
    });
  } finally {
    if (tempDir) {
      await cleanup([tempDir]).catch(() => {});
    }
  }
});

/**
 * Remove a post's public HLS when it must no longer exist: the post was
 * deleted, hidden, made VIP, expired, its media changed, or its author is being
 * deleted (CTO review finding 3). A post that is still eligible keeps its HLS
 * (409), so the app's key cannot be used to strip anyone's video.
 * Body: { postId }.
 */
app.post('/api/revoke-hls', authenticate, express.json(), async (req: Request, res: Response) => {
  const { postId } = req.body ?? {};
  if (!isUuid(postId)) {
    return res.status(400).json({ success: false, error: 'postId (a UUID) is required' });
  }
  try {
    const { post, deletionPending } = await loadPolicyInputs(postId);
    if (!revokeRequired(post, deletionPending)) {
      return res.status(409).json({ success: false, error: 'post is still eligible; HLS kept' });
    }
    const folder = hlsFolderFor(postId, migrationConfig.storage.targetFolder);
    if (await storageService.otherPostUsesFolder(postId, folder)) {
      return res.status(409).json({ success: false, error: 'another post plays HLS from this folder; kept' });
    }
    const removed = await storageService.removeFolder(folder);
    if (post) {
      await storageService.clearHlsUrl(postId, folder);
    }
    logger.info(`Revoked HLS: ${removed} object(s) removed`);
    return res.json({ success: true, removed });
  } catch (error) {
    logger.error('Revoke HLS error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Revoke failed'
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

