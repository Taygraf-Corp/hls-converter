import ffmpeg from 'fluent-ffmpeg';
import { ConversionOptions, ConversionJob, Resolution, VideoMetadata, AspectRatio } from '../types/index.js';
import { resolutionSets } from '../config/index.js';
import { logger } from '../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';

export class FFmpegService {
  /**
   * Extract video metadata including dimensions and aspect ratio
   */
  async getVideoMetadata(inputPath: string): Promise<VideoMetadata> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputPath, (error, metadata) => {
        if (error) {
          logger.error('Error extracting video metadata:', error);
          reject(error);
          return;
        }

        const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
        if (!videoStream || !videoStream.width || !videoStream.height) {
          reject(new Error('No video stream found or missing dimensions'));
          return;
        }

        const width = videoStream.width;
        const height = videoStream.height;
        const duration = typeof metadata.format.duration === 'number' 
          ? metadata.format.duration 
          : parseFloat(metadata.format.duration || '0');
        const bitrate = typeof metadata.format.bit_rate === 'number'
          ? metadata.format.bit_rate
          : parseInt(metadata.format.bit_rate || '0');

        const aspectRatio = this.detectAspectRatio(width, height);

        resolve({
          width,
          height,
          duration,
          aspectRatio,
          bitrate
        });
      });
    });
  }

  /**
   * Detect aspect ratio category based on video dimensions
   */
  private detectAspectRatio(width: number, height: number): AspectRatio {
    const ratio = width / height;
    
    // Define thresholds for aspect ratio detection
    const PORTRAIT_THRESHOLD = 0.75;  // 3:4 and narrower (including 9:16)
    const SQUARE_THRESHOLD_LOW = 0.9; // Close to square
    const SQUARE_THRESHOLD_HIGH = 1.1; // Close to square
    
    if (ratio < PORTRAIT_THRESHOLD) {
      return 'portrait';
    } else if (ratio >= SQUARE_THRESHOLD_LOW && ratio <= SQUARE_THRESHOLD_HIGH) {
      return 'square';
    } else {
      return 'landscape';
    }
  }

  /**
   * Get appropriate resolution ladder based on aspect ratio
   */
  getResolutionsForAspectRatio(aspectRatio: AspectRatio): Resolution[] {
    return resolutionSets[aspectRatio];
  }

  /**
   * Create conversion options with smart resolution selection
   */
  async createSmartConversionOptions(
    inputPath: string, 
    baseOptions: ConversionOptions
  ): Promise<ConversionOptions> {
    const metadata = await this.getVideoMetadata(inputPath);
    const appropriateResolutions = this.getResolutionsForAspectRatio(metadata.aspectRatio);
    
    // Filter resolutions to not exceed source resolution
    const filteredResolutions = appropriateResolutions.filter(res => 
      res.width <= metadata.width && res.height <= metadata.height
    );
    
    // If no resolutions fit, use the smallest one from the appropriate set
    const finalResolutions = filteredResolutions.length > 0 
      ? filteredResolutions 
      : [appropriateResolutions[0]];

    logger.info(`Detected ${metadata.aspectRatio} video (${metadata.width}x${metadata.height}), using ${finalResolutions.length} resolution(s)`);

    return {
      ...baseOptions,
      resolutions: finalResolutions
    };
  }

  /**
   * Test FFmpeg capabilities and codecs
   */
  async testCapabilities(): Promise<{ hls: boolean; dash: boolean; codecs: string[] }> {
    try {
      const metadata = await new Promise<any>((resolve, reject) => {
        ffmpeg()
          .outputOptions(['-f', 'null', '-'])
          .input('color=black:size=320x240:duration=1')
          .inputOptions(['-f', 'lavfi'])
          .on('end', () => resolve({ success: true }))
          .on('error', (error) => reject(error))
          .run();
      });

      return {
        hls: true,
        dash: true,
        codecs: ['libx264', 'aac']
      };
    } catch (error) {
      logger.warn('FFmpeg capability test failed:', error);
      return {
        hls: true,
        dash: false, // Disable DASH if test fails
        codecs: ['libx264', 'aac']
      };
    }
  }
  /**
   * Convert MP4 to HLS with multiple bitrates and resolutions
   */
  async convertToHls(
    inputPath: string,
    outputDir: string,
    options: ConversionOptions,
    onProgress?: (progress: number) => void
  ): Promise<string[]> {
    try {
      // Ensure output directory exists
      await fs.mkdir(outputDir, { recursive: true });

      const outputFiles: string[] = [];
      
      // Create master playlist path
      const masterPlaylistPath = path.join(outputDir, 'master.m3u8');
      
      // Generate variant playlists for each resolution
      const variantPlaylists: string[] = [];
      
      for (let i = 0; i < options.resolutions.length; i++) {
        const resolution = options.resolutions[i];
        const variantName = `${resolution.height}p`;
        const variantPlaylist = `${variantName}.m3u8`;
        const segmentPattern = `${variantName}_%03d.ts`;
        
        variantPlaylists.push(variantPlaylist);
        
        await this.createVariantStream(
          inputPath,
          path.join(outputDir, variantPlaylist),
          path.join(outputDir, segmentPattern),
          resolution,
          options,
          onProgress ? (p) => onProgress((i + p / 100) / options.resolutions.length * 100) : undefined
        );
        
        outputFiles.push(variantPlaylist);
      }
      
      // Create master playlist
      await this.createMasterPlaylist(masterPlaylistPath, options.resolutions, variantPlaylists);
      outputFiles.push('master.m3u8');
      
      // Add all segment files
      const segmentFiles = await this.getSegmentFiles(outputDir);
      outputFiles.push(...segmentFiles);
      
      logger.info(`HLS conversion completed. Generated ${outputFiles.length} files.`);
      return outputFiles;
      
    } catch (error) {
      logger.error('Error converting to HLS:', error);
      throw error;
    }
  }

  /**
   * Convert MP4 to CMAF (fragmented MP4)
   */
  async convertToCmaf(
    inputPath: string,
    outputDir: string,
    options: ConversionOptions,
    onProgress?: (progress: number) => void
  ): Promise<string[]> {
    try {
      await fs.mkdir(outputDir, { recursive: true });
      
      const outputFiles: string[] = [];
      const manifestPath = path.join(outputDir, 'manifest.mpd');
      
      // Try advanced DASH conversion first, fallback to simple if it fails
      try {
        await this.convertToCmafAdvanced(inputPath, manifestPath, options, onProgress);
      } catch (advancedError) {
        logger.warn('Advanced CMAF conversion failed, trying simple approach:', advancedError);
        await this.convertToCmafSimple(inputPath, manifestPath, options, onProgress);
      }

      // Collect all generated files
      const files = await fs.readdir(outputDir);
      outputFiles.push(...files);
      
      logger.info(`CMAF conversion completed. Generated ${outputFiles.length} files.`);
      return outputFiles;
      
    } catch (error) {
      logger.error('Error converting to CMAF:', error);
      throw error;
    }
  }

  /**
   * Advanced CMAF conversion with multiple bitrates
   */
  private async convertToCmafAdvanced(
    inputPath: string,
    manifestPath: string,
    options: ConversionOptions,
    onProgress?: (progress: number) => void
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Build the command with proper DASH options and stream mapping
      const command = ffmpeg(inputPath);
      
      // Map video streams for each resolution
      options.resolutions.forEach(() => {
        command.outputOptions(['-map', '0:v:0']);
      });
      
      // Map audio stream
      command.outputOptions(['-map', '0:a:0']);
      
      // Configure each video stream with its specific settings
      options.resolutions.forEach((resolution, index) => {
        command.outputOptions([
          `-c:v:${index}`, 'libx264',
          `-b:v:${index}`, resolution.bitrate.toString(),
          `-s:v:${index}`, `${resolution.width}x${resolution.height}`,
          `-profile:v:${index}`, 'main',
          `-level:v:${index}`, '3.1'
        ]);
      });
      
      // Configure audio stream
      command.outputOptions([
        '-c:a:0', 'aac',
        '-b:a:0', options.audioBitrate.toString(),
        '-ac', '2'
      ]);
      
      // Add DASH format options
      command.outputOptions([
        '-f', 'dash',
        '-seg_duration', options.cmafFragmentDuration.toString(),
        '-use_template', '1',
        '-use_timeline', '1',
        '-init_seg_name', 'init-$RepresentationID$.m4s',
        '-media_seg_name', 'chunk-$RepresentationID$-$Number$.m4s',
        `-adaptation_sets`, `id=0,streams=${options.resolutions.map((_, i) => i).join(',')} id=1,streams=${options.resolutions.length}`,
        '-preset', 'medium',
        '-movflags', '+faststart',
        '-avoid_negative_ts', 'make_zero'
      ]);

      if (onProgress) {
        command.on('progress', (progress) => {
          onProgress(progress.percent || 0);
        });
      }

      // Add better error handling
      command.on('stderr', (stderrLine) => {
        logger.debug('FFmpeg stderr:', stderrLine);
      });

      command
        .output(manifestPath)
        .on('end', () => {
          logger.info('Advanced CMAF conversion completed');
          resolve();
        })
        .on('error', (error, stdout, stderr) => {
          logger.error('Advanced CMAF conversion failed:', error);
          logger.error('FFmpeg stdout:', stdout);
          logger.error('FFmpeg stderr:', stderr);
          reject(new Error(`Advanced CMAF conversion failed: ${error.message}\nStderr: ${stderr}`));
        })
        .run();
    });
  }

  /**
   * Simple CMAF conversion with single bitrate
   */
  private async convertToCmafSimple(
    inputPath: string,
    manifestPath: string,
    options: ConversionOptions,
    onProgress?: (progress: number) => void
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Use the highest resolution for simple conversion
      const targetResolution = options.resolutions[options.resolutions.length - 1];
      
      const command = ffmpeg(inputPath)
        .outputOptions([
          '-f', 'dash',
          '-seg_duration', options.cmafFragmentDuration.toString(),
          '-c:v', 'libx264',
          '-b:v', targetResolution.bitrate.toString(),
          '-s', `${targetResolution.width}x${targetResolution.height}`,
          '-profile:v', 'main',
          '-level', '3.1',
          '-preset', 'fast',
          '-c:a', 'aac',
          '-b:a', options.audioBitrate.toString(),
          '-movflags', '+faststart'
        ]);

      if (onProgress) {
        command.on('progress', (progress) => {
          onProgress(progress.percent || 0);
        });
      }

      command.on('stderr', (stderrLine) => {
        logger.debug('FFmpeg stderr:', stderrLine);
      });

      command
        .output(manifestPath)
        .on('end', () => {
          logger.info('Simple CMAF conversion completed');
          resolve();
        })
        .on('error', (error, stdout, stderr) => {
          logger.error('Simple CMAF conversion failed:', error);
          logger.error('FFmpeg stdout:', stdout);
          logger.error('FFmpeg stderr:', stderr);
          reject(new Error(`Simple CMAF conversion failed: ${error.message}\nStderr: ${stderr}`));
        })
        .run();
    });
  }

  /**
   * Create a variant stream for HLS
   */
  private async createVariantStream(
    inputPath: string,
    playlistPath: string,
    segmentPattern: string,
    resolution: Resolution,
    options: ConversionOptions,
    onProgress?: (progress: number) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const command = ffmpeg(inputPath)
        .outputOptions([
          '-c:v', 'libx264',
          '-c:a', 'aac',
          '-b:v', resolution.bitrate.toString(),
          '-b:a', options.audioBitrate.toString(),
          '-s', `${resolution.width}x${resolution.height}`,
          '-profile:v', 'main',
          '-level', '3.1',
          '-preset', 'medium',
          '-crf', '23',
          '-maxrate', (resolution.bitrate * 1.2).toString(),
          '-bufsize', (resolution.bitrate * 2).toString(),
          '-start_number', '0',
          '-hls_time', options.hlsSegmentDuration.toString(),
          '-hls_list_size', '0',
          '-hls_playlist_type', options.hlsPlaylistType,
          '-hls_segment_filename', segmentPattern,
          '-hls_flags', 'independent_segments',
          '-f', 'hls'
        ]);

      if (onProgress) {
        command.on('progress', (progress) => {
          onProgress(progress.percent || 0);
        });
      }

      // Add better error handling
      command.on('stderr', (stderrLine) => {
        logger.debug('FFmpeg stderr:', stderrLine);
      });

      command
        .output(playlistPath)
        .on('end', () => {
          logger.debug(`Variant stream created: ${playlistPath}`);
          resolve();
        })
        .on('error', (error, stdout, stderr) => {
          logger.error(`Error creating variant stream ${playlistPath}:`, error);
          logger.error('FFmpeg stdout:', stdout);
          logger.error('FFmpeg stderr:', stderr);
          reject(new Error(`HLS conversion failed: ${error.message}\nStderr: ${stderr}`));
        })
        .run();
    });
  }

  /**
   * Create master playlist for HLS
   */
  private async createMasterPlaylist(
    masterPath: string,
    resolutions: Resolution[],
    variantPlaylists: string[]
  ): Promise<void> {
    let masterContent = '#EXTM3U\n#EXT-X-VERSION:3\n\n';
    
    resolutions.forEach((resolution, index) => {
      const playlist = variantPlaylists[index];
      masterContent += `#EXT-X-STREAM-INF:BANDWIDTH=${resolution.bitrate},RESOLUTION=${resolution.width}x${resolution.height}\n`;
      masterContent += `${playlist}\n\n`;
    });
    
    await fs.writeFile(masterPath, masterContent);
    logger.debug(`Master playlist created: ${masterPath}`);
  }

  /**
   * Get all segment files from output directory
   */
  private async getSegmentFiles(outputDir: string): Promise<string[]> {
    const files = await fs.readdir(outputDir);
    return files.filter(file => 
      file.endsWith('.ts') || 
      file.endsWith('.m4s') || 
      (file.endsWith('.m3u8') && file !== 'master.m3u8')
    );
  }

  // /**
  //  * Get video metadata using ffprobe
  //  */
  // async getVideoMetadata(inputPath: string): Promise<any> {
  //   return new Promise((resolve, reject) => {
  //     ffmpeg.ffprobe(inputPath, (error, metadata) => {
  //       if (error) {
  //         // Provide more helpful error messages for common issues
  //         if (error.message && error.message.includes('Cannot find ffprobe')) {
  //           const helpfulError = new Error(
  //             'FFmpeg is not installed or not found in PATH. Please install FFmpeg:\n' +
  //             '  Ubuntu/Debian: sudo apt update && sudo apt install ffmpeg\n' +
  //             '  macOS: brew install ffmpeg\n' +
  //             '  Windows: Download from https://ffmpeg.org/download.html'
  //           );
  //           helpfulError.stack = error.stack;
  //           reject(helpfulError);
  //         } else {
  //           reject(error);
  //         }
  //       } else {
  //         resolve(metadata);
  //       }
  //     });
  //   });
  // }

  /**
   * Validate video file
   */
  async validateVideo(inputPath: string): Promise<boolean> {
    try {
      const metadata = await this.getVideoMetadata(inputPath);
      
      // Check if video has valid dimensions
      if (!metadata.width || !metadata.height || metadata.width <= 0 || metadata.height <= 0) {
        logger.warn(`File ${inputPath} does not have valid video dimensions`);
        return false;
      }
      
      // Check if video has reasonable duration
      if (metadata.duration <= 0) {
        logger.warn(`File ${inputPath} has invalid duration`);
        return false;
      }
      
      return true;
    } catch (error) {
      logger.error(`Error validating video ${inputPath}:`, error);
      return false;
    }
  }
}
