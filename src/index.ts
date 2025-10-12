/**
 * Taygram Video Migration Library
 * 
 * This library provides utilities to migrate MP4 videos stored in Supabase
 * to HLS and CMAF formats for adaptive streaming.
 */

export { VideoMigrationService } from './services/migration.js';
export { SupabaseStorageService } from './services/supabase.js';
export { FFmpegService } from './services/ffmpeg.js';

export type {
  VideoFile,
  ConversionOptions,
  ConversionJob,
  Resolution,
  MigrationConfig,
  MigrationProgress,
  StorageFile
} from './types/index.js';

export { migrationConfig, defaultConversionOptions } from './config/index.js';
export { logger } from './utils/logger.js';
export * from './utils/file-utils.js';

// Example usage:
// import { VideoMigrationService } from 'taygram-video-migration';
// 
// const migrationService = new VideoMigrationService();
// 
// // Migrate all videos
// await migrationService.migrateAllVideos({
//   outputFormat: 'both', // 'hls', 'cmaf', or 'both'
//   hlsSegmentDuration: 6,
//   resolutions: [
//     { width: 1280, height: 720, bitrate: 1200000 },
//     { width: 1920, height: 1080, bitrate: 2000000 }
//   ]
// });
// 
// // Migrate single video
// const videoFile = { name: 'video.mp4', path: 'video.mp4', size: 1000000, bucket: 'videos' };
// await migrationService.migrateVideo(videoFile, conversionOptions);
