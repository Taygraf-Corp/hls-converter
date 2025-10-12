#!/usr/bin/env node

import { VideoMigrationService } from './services/migration.js';
import { ConversionOptions } from './types/index.js';
import { logger } from './utils/logger.js';
import { ensureDir } from './utils/file-utils.js';
import { migrationConfig } from './config/index.js';

interface MigrationCliOptions {
  outputFormat?: 'hls' | 'cmaf' | 'both';
  maxConcurrent?: number;
  retryFailed?: boolean;
  dryRun?: boolean;
  filter?: string;
  limit?: number;
}

async function main() {
  try {
    // Parse command line arguments
    const args = process.argv.slice(2);
    const options: MigrationCliOptions = {};
    
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      switch (arg) {
        case '--format':
          options.outputFormat = args[++i] as 'hls' | 'cmaf' | 'both';
          break;
        case '--concurrent':
          options.maxConcurrent = parseInt(args[++i]);
          break;
        case '--retry-failed':
          options.retryFailed = true;
          break;
        case '--dry-run':
          options.dryRun = true;
          break;
        case '--filter':
          options.filter = args[++i];
          break;
        case '--limit':
          options.limit = parseInt(args[++i]);
          break;
        case '--help':
          printHelp();
          process.exit(0);
        default:
          if (arg.startsWith('--')) {
            logger.error(`Unknown option: ${arg}`);
            printHelp();
            process.exit(1);
          }
          break;
      }
    }

    // Ensure temp directory exists
    await ensureDir(migrationConfig.processing.tempDir);

    logger.info('Starting Taygram Video Migration');
    logger.info(`Configuration:`);
    logger.info(`  Source: ${migrationConfig.storage.sourceBucket}/${migrationConfig.storage.sourceFolder}`);
    logger.info(`  Target: ${migrationConfig.storage.targetBucket}/${migrationConfig.storage.targetFolder}`);
    logger.info(`  Max Concurrent Jobs: ${migrationConfig.processing.maxConcurrentJobs}`);
    logger.info(`  Output Format: ${options.outputFormat || migrationConfig.hls.outputFormat}`);
    if (options.limit) {
      logger.info(`  Limit: Processing only ${options.limit} videos`);
    }
    
    if (options.dryRun) {
      logger.info('DRY RUN MODE - Scanning for videos...');
      
      // In dry run mode, let's list what videos we would process
      const { SupabaseStorageService } = await import('./services/supabase.js');
      const storageService = new SupabaseStorageService();
      
      try {
        const allVideoFiles = await storageService.listMp4Files();
        const videoFiles = options.limit ? allVideoFiles.slice(0, options.limit) : allVideoFiles;
        
        logger.info(`Found ${allVideoFiles.length} MP4 files total${options.limit ? `, showing first ${videoFiles.length}` : ''}:`);
        
        videoFiles.forEach((file, index) => {
          logger.info(`  ${index + 1}. ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
        });
        
        if (videoFiles.length === 0) {
          logger.warn(`No MP4 files found in ${migrationConfig.storage.sourceBucket}/${migrationConfig.storage.sourceFolder}`);
          logger.info('Please check:');
          logger.info('  1. Your Supabase credentials are correct');
          logger.info(`  2. The source bucket "${migrationConfig.storage.sourceBucket}" exists`);
          logger.info(`  3. Videos are stored in the "${migrationConfig.storage.sourceFolder}" folder within the bucket`);
          logger.info('  4. Your Supabase user has read access to the storage');
        }
      } catch (error) {
        logger.error('Error scanning for videos:', error);
      }
      
      return;
    }

    const migrationService = new VideoMigrationService();
    
    // Create conversion options
    const conversionOptions: Partial<ConversionOptions> = {};
    if (options.outputFormat) {
      conversionOptions.outputFormat = options.outputFormat;
    }

    // Progress callback
    const onProgress = (progress: any) => {
      const percentage = ((progress.processedFiles + progress.failedFiles) / progress.totalFiles * 100).toFixed(1);
      logger.info(`Progress: ${percentage}% (${progress.processedFiles}/${progress.totalFiles} processed, ${progress.failedFiles} failed)`);
      
      if (progress.currentJob) {
        logger.info(`  Current: ${progress.currentJob.sourceFile.name} - ${progress.currentJob.progress.toFixed(1)}%`);
      }
    };

    let result;
    
    if (options.retryFailed) {
      logger.info('Retrying failed migrations...');
      result = await migrationService.retryFailedMigrations(conversionOptions, onProgress);
    } else {
      logger.info('Starting migration of videos...');
      result = await migrationService.migrateAllVideos(conversionOptions, onProgress, options.limit);
    }

    // Final summary
    logger.info('\n=== Migration Summary ===');
    logger.info(`Total files: ${result.totalFiles}`);
    logger.info(`Successfully processed: ${result.processedFiles}`);
    logger.info(`Failed: ${result.failedFiles}`);
    
    if (result.failedFiles > 0) {
      logger.warn('Some files failed to process. Use --retry-failed to retry them.');
      const failedJobs = migrationService.getAllJobs().filter(job => job.status === 'failed');
      failedJobs.forEach(job => {
        logger.warn(`  Failed: ${job.sourceFile.name} - ${job.error}`);
      });
    }
    
    logger.info('Migration completed successfully!');
    
  } catch (error) {
    logger.error('Migration failed:', error);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
Taygram Video Migration Tool

Usage: npm run migrate [options]

Options:
  --format <hls|cmaf|both>    Output format (default: both)
  --concurrent <number>       Max concurrent jobs (default: 3)
  --limit <number>           Process only the first N videos (useful for testing)
  --retry-failed             Retry only failed migrations
  --dry-run                  Show what would be processed without doing it
  --filter <pattern>         Filter files by name pattern
  --help                     Show this help message

Examples:
  npm run migrate                           # Migrate all videos to HLS and CMAF
  npm run migrate -- --limit 5             # Process only the first 5 videos
  npm run migrate -- --format hls          # Migrate to HLS only
  npm run migrate -- --concurrent 5        # Use 5 concurrent jobs
  npm run migrate -- --retry-failed        # Retry failed migrations
  npm run migrate -- --dry-run             # Preview what would be processed
  npm run migrate -- --dry-run --limit 10  # Preview first 10 videos
`);
}

// Handle process signals
process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    logger.error('Unhandled error:', error);
    process.exit(1);
  });
}