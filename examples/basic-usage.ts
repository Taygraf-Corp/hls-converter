/**
 * Basic usage example for Taygram Video Migration
 */

import { VideoMigrationService, ConversionOptions } from '../src/index.js';
import { logger } from '../src/utils/logger.js';

async function basicMigrationExample() {
  try {
    // Initialize the migration service
    const migrationService = new VideoMigrationService();

    // Define custom conversion options
    const options: Partial<ConversionOptions> = {
      outputFormat: 'both', // Convert to both HLS and CMAF
      hlsSegmentDuration: 6, // 6-second segments
      resolutions: [
        { width: 854, height: 480, bitrate: 800000 },   // 480p
        { width: 1280, height: 720, bitrate: 1200000 }, // 720p
        { width: 1920, height: 1080, bitrate: 2000000 } // 1080p
      ]
    };

    // Progress tracking callback
    const onProgress = (progress: any) => {
      const percentage = ((progress.processedFiles + progress.failedFiles) / progress.totalFiles * 100).toFixed(1);
      logger.info(`Overall Progress: ${percentage}% (${progress.processedFiles}/${progress.totalFiles} completed)`);
      
      if (progress.currentJob) {
        logger.info(`  Processing: ${progress.currentJob.sourceFile.name} - ${progress.currentJob.progress.toFixed(1)}%`);
      }
    };

    logger.info('Starting video migration...');
    
    // Start the migration
    const result = await migrationService.migrateAllVideos(options, onProgress);

    // Log final results
    logger.info('\\n=== Migration Complete ===');
    logger.info(`Total files processed: ${result.processedFiles}`);
    logger.info(`Failed files: ${result.failedFiles}`);
    
    if (result.failedFiles > 0) {
      logger.warn('Some files failed to process. Check logs for details.');
      
      // Optionally retry failed files
      logger.info('Retrying failed migrations...');
      const retryResult = await migrationService.retryFailedMigrations(options, onProgress);
      logger.info(`Retry completed: ${retryResult.processedFiles} additional files processed`);
    }

  } catch (error) {
    logger.error('Migration failed:', error);
    process.exit(1);
  }
}

// Run the example if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  basicMigrationExample().catch(error => {
    logger.error('Unhandled error:', error);
    process.exit(1);
  });
}
