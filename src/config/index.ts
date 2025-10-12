import { config } from 'dotenv';
import { MigrationConfig, ConversionOptions, ResolutionSet } from '../types/index.js';

config();

const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY', 
];

// Validate required environment variables
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

// Resolution sets for different aspect ratios
const resolutionSets: ResolutionSet = {
  // Portrait videos (9:16) - TikTok, Instagram Stories, etc.
  portrait: [
    { width: 360, height: 640, bitrate: 400000 },   // 360x640 (low mobile)
    { width: 480, height: 854, bitrate: 800000 },   // 480x854 (medium mobile)  
    { width: 720, height: 1280, bitrate: 1200000 }, // 720x1280 (high mobile)
    { width: 1080, height: 1920, bitrate: 2000000 } // 1080x1920 (ultra mobile)
  ],
  // Landscape videos (16:9) - YouTube, traditional video
  landscape: [
    { width: 640, height: 360, bitrate: 400000 },   // 360p
    { width: 854, height: 480, bitrate: 800000 },   // 480p  
    { width: 1280, height: 720, bitrate: 1200000 }, // 720p
    { width: 1920, height: 1080, bitrate: 2000000 } // 1080p
  ],
  // Square videos (1:1) - Instagram posts, some social media
  square: [
    { width: 360, height: 360, bitrate: 400000 },   // 360x360
    { width: 480, height: 480, bitrate: 800000 },   // 480x480
    { width: 720, height: 720, bitrate: 1200000 },  // 720x720
    { width: 1080, height: 1080, bitrate: 2000000 } // 1080x1080
  ]
};

const defaultConversionOptions: ConversionOptions = {
  hlsSegmentDuration: parseInt(process.env.HLS_SEGMENT_DURATION || '6'),
  hlsPlaylistType: (process.env.HLS_PLAYLIST_TYPE as 'vod' | 'event') || 'vod',
  cmafFragmentDuration: parseInt(process.env.CMAF_FRAGMENT_DURATION || '2'),
  videoBitrates: [400000, 800000, 1200000, 2000000], // 400k, 800k, 1.2M, 2M
  audioBitrate: 128000, // 128k
  resolutions: resolutionSets.landscape, // Default to landscape (will be overridden by smart detection)
  outputFormat: 'hls' as const // Default to HLS-only for efficiency, CMAF available on demand
};

export const migrationConfig: MigrationConfig = {
  supabase: {
    url: process.env.SUPABASE_URL!,
    anonKey: process.env.SUPABASE_ANON_KEY!,
  },
  storage: {
    sourceBucket: process.env.SOURCE_BUCKET || 'videos',
    sourceFolder: process.env.SOURCE_FOLDER || 'Videos',
    targetBucket: process.env.TARGET_BUCKET || 'hls-videos',
    targetFolder: process.env.TARGET_FOLDER || 'converted',
  },
  processing: {
    maxConcurrentJobs: parseInt(process.env.MAX_CONCURRENT_JOBS || '3'),
    tempDir: process.env.TEMP_DIR || './temp',
  },
  hls: defaultConversionOptions
};

export { defaultConversionOptions, resolutionSets };
