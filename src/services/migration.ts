import { SupabaseStorageService } from './supabase.js';
import { FFmpegService } from './ffmpeg.js';
import { VideoFile, ConversionJob, ConversionOptions, MigrationProgress } from '../types/index.js';
import { migrationConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { ensureDir, cleanup, generateTempDir, getFilenameWithoutExtension } from '../utils/file-utils.js';
import pLimit from 'p-limit';
import path from 'path';

export class VideoMigrationService {
  private storageService: SupabaseStorageService;
  private ffmpegService: FFmpegService;
  private concurrencyLimit: ReturnType<typeof pLimit>;
  private jobs: Map<string, ConversionJob> = new Map();
  private progress: MigrationProgress = {
    totalFiles: 0,
    processedFiles: 0,
    failedFiles: 0
  };

  constructor() {
    this.storageService = new SupabaseStorageService();
    this.ffmpegService = new FFmpegService();
    this.concurrencyLimit = pLimit(migrationConfig.processing.maxConcurrentJobs);
  }

  /**
   * Migrate all MP4 files to HLS/CMAF format
   */
  async migrateAllVideos(
    options?: Partial<ConversionOptions>,
    onProgress?: (progress: MigrationProgress) => void,
    limit?: number
  ): Promise<MigrationProgress> {
    try {
      logger.info('Starting video migration process...');
      
      // Get list of MP4 files
      const allVideoFiles = await this.storageService.listMp4Files();
      const videoFiles = limit ? allVideoFiles.slice(0, limit) : allVideoFiles;
      
      if (videoFiles.length === 0) {
        logger.info('No MP4 files found to migrate');
        return this.progress;
      }

      this.progress.totalFiles = videoFiles.length;
      logger.info(`Found ${allVideoFiles.length} MP4 files total${limit ? `, processing first ${videoFiles.length}` : ', processing all'}`);

      // Create conversion options
      const conversionOptions: ConversionOptions = {
        ...migrationConfig.hls,
        ...options
      };

      // Process files with concurrency limit
      const migrationPromises = videoFiles.map(videoFile =>
        this.concurrencyLimit(() => this.migrateVideo(videoFile, conversionOptions, onProgress))
      );

      await Promise.allSettled(migrationPromises);

      logger.info(`Migration completed. Processed: ${this.progress.processedFiles}, Failed: ${this.progress.failedFiles}`);
      return this.progress;

    } catch (error) {
      logger.error('Error during migration:', error);
      throw error;
    }
  }

  /**
   * Migrate a single video file
   */
  async migrateVideo(
    videoFile: VideoFile,
    options: ConversionOptions,
    onProgress?: (progress: MigrationProgress) => void
  ): Promise<ConversionJob> {
    const jobId = `${videoFile.name}-${Date.now()}`;
    const baseFilename = getFilenameWithoutExtension(videoFile.name);
    
    const job: ConversionJob = {
      id: jobId,
      sourceFile: videoFile,
      targetPath: `${migrationConfig.storage.targetFolder}/${baseFilename}/`,
      options,
      status: 'pending',
      progress: 0,
      outputFiles: []
    };

    this.jobs.set(jobId, job);
    this.progress.currentJob = job;

    try {
      logger.info(`Starting migration for ${videoFile.name}`);
      
      // Check if already converted
      const existingFiles = await this.checkExistingConversion(baseFilename);
      if (existingFiles.length > 0) {
        logger.info(`${videoFile.name} already converted, skipping...`);
        job.status = 'completed';
        job.outputFiles = existingFiles;
        this.progress.processedFiles++;
        return job;
      }

      job.status = 'processing';
      job.startTime = new Date();

      // Create temporary directory
      const tempDir = generateTempDir(migrationConfig.processing.tempDir, `migration-${baseFilename}`);
      await ensureDir(tempDir);

      const inputPath = path.join(tempDir, videoFile.name);
      const outputDir = path.join(tempDir, 'output');

      try {
        // Download source file
        logger.info(`Downloading ${videoFile.name}...`);
        await this.storageService.downloadFile(videoFile, inputPath);
        job.progress = 10;

        // Validate video file
        const isValid = await this.ffmpegService.validateVideo(inputPath);
        if (!isValid) {
          throw new Error(`Invalid video file: ${videoFile.name}`);
        }
        job.progress = 15;

        // Create smart conversion options based on video aspect ratio
        const smartOptions = await this.ffmpegService.createSmartConversionOptions(inputPath, options);
        logger.info(`Using smart conversion options for ${videoFile.name}: ${smartOptions.resolutions.length} resolution(s)`);
        job.progress = 20;

        // Convert based on output format
        let outputFiles: string[] = [];
        
        if (smartOptions.outputFormat === 'hls' || smartOptions.outputFormat === 'both') {
          logger.info(`Converting ${videoFile.name} to HLS...`);
          const hlsDir = path.join(outputDir, 'hls');
          const hlsFiles = await this.ffmpegService.convertToHls(
            inputPath,
            hlsDir,
            smartOptions,
            (progress) => {
              job.progress = 20 + (progress * 0.4); // 20-60% for HLS
              if (onProgress) onProgress(this.progress);
            }
          );
          
          // Upload HLS files
          logger.info(`Uploading HLS files for ${videoFile.name}...`);
          const uploadedHlsFiles = await this.storageService.uploadHlsFiles(
            hlsDir,
            `${migrationConfig.storage.targetFolder}/${baseFilename}/hls`
          );
          outputFiles.push(...uploadedHlsFiles.map(f => `hls/${path.basename(f)}`));
          job.progress = 65;
        }

        if (smartOptions.outputFormat === 'cmaf' || smartOptions.outputFormat === 'both') {
          try {
            logger.info(`Converting ${videoFile.name} to CMAF...`);
            const cmafDir = path.join(outputDir, 'cmaf');
            const cmafFiles = await this.ffmpegService.convertToCmaf(
              inputPath,
              cmafDir,
              smartOptions,
              (progress) => {
                const baseProgress = smartOptions.outputFormat === 'both' ? 65 : 20;
                job.progress = baseProgress + (progress * 0.3); // 30% for CMAF
                if (onProgress) onProgress(this.progress);
              }
            );
            
            // Upload CMAF files
            logger.info(`Uploading CMAF files for ${videoFile.name}...`);
            const uploadedCmafFiles = await this.storageService.uploadHlsFiles(
              cmafDir,
              `${migrationConfig.storage.targetFolder}/${baseFilename}/cmaf`
            );
            outputFiles.push(...uploadedCmafFiles.map(f => `cmaf/${path.basename(f)}`));
            job.progress = 95;
          } catch (cmafError) {
            logger.warn(`CMAF conversion failed for ${videoFile.name}, continuing with HLS only:`, cmafError);
            
            // If CMAF-only was requested and it fails, throw the error
            if (smartOptions.outputFormat === 'cmaf') {
              throw cmafError;
            }
            
            // If 'both' was requested, continue with just HLS
            logger.info(`Continuing with HLS-only conversion for ${videoFile.name}`);
            job.progress = 95;
          }
        }

        job.outputFiles = outputFiles;
        job.status = 'completed';
        job.endTime = new Date();
        job.progress = 100;
        
        this.progress.processedFiles++;
        logger.info(`Successfully migrated ${videoFile.name} (${outputFiles.length} files generated)`);

      } finally {
        // Cleanup temporary files
        await cleanup([tempDir]);
      }

    } catch (error) {
      logger.error(`Error migrating ${videoFile.name}:`, error);
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : 'Unknown error';
      job.endTime = new Date();
      this.progress.failedFiles++;
    }

    if (onProgress) {
      onProgress(this.progress);
    }

    return job;
  }

  /**
   * Check if video has already been converted
   */
  private async checkExistingConversion(baseFilename: string): Promise<string[]> {
    try {
      const hlsExists = await this.storageService.fileExists(`${migrationConfig.storage.targetFolder}/${baseFilename}/hls/master.m3u8`);
      const cmafExists = await this.storageService.fileExists(`${migrationConfig.storage.targetFolder}/${baseFilename}/cmaf/manifest.mpd`);
      
      const existingFiles: string[] = [];
      if (hlsExists) existingFiles.push('hls/master.m3u8');
      if (cmafExists) existingFiles.push('cmaf/manifest.mpd');
      
      return existingFiles;
    } catch (error) {
      logger.debug(`Error checking existing conversion for ${baseFilename}:`, error);
      return [];
    }
  }

  /**
   * Get migration progress
   */
  getProgress(): MigrationProgress {
    return { ...this.progress };
  }

  /**
   * Get job status
   */
  getJob(jobId: string): ConversionJob | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Get all jobs
   */
  getAllJobs(): ConversionJob[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Cancel migration (stops processing new files)
   */
  async cancelMigration(): Promise<void> {
    logger.info('Migration cancellation requested');
    // Note: This is a simple implementation. In a production environment,
    // you might want to implement more sophisticated cancellation logic
  }

  /**
   * Retry failed migrations
   */
  async retryFailedMigrations(
    options?: Partial<ConversionOptions>,
    onProgress?: (progress: MigrationProgress) => void
  ): Promise<MigrationProgress> {
    const failedJobs = Array.from(this.jobs.values()).filter(job => job.status === 'failed');
    
    if (failedJobs.length === 0) {
      logger.info('No failed migrations to retry');
      return this.progress;
    }

    logger.info(`Retrying ${failedJobs.length} failed migrations`);
    
    const conversionOptions: ConversionOptions = {
      ...migrationConfig.hls,
      ...options
    };

    const retryPromises = failedJobs.map(job =>
      this.concurrencyLimit(() => this.migrateVideo(job.sourceFile, conversionOptions, onProgress))
    );

    await Promise.allSettled(retryPromises);
    
    return this.progress;
  }
}
