export interface VideoFile {
  name: string;
  path: string;
  size: number;
  bucket: string;
  lastModified?: Date;
  metadata?: Record<string, any>;
}

export interface ConversionOptions {
  hlsSegmentDuration: number;
  hlsPlaylistType: 'vod' | 'event';
  cmafFragmentDuration: number;
  videoBitrates: number[];
  audioBitrate: number;
  resolutions: Resolution[];
  outputFormat: 'hls' | 'cmaf' | 'both';
}

export interface Resolution {
  width: number;
  height: number;
  bitrate: number;
}

export type AspectRatio = 'portrait' | 'landscape' | 'square';

export interface VideoMetadata {
  width: number;
  height: number;
  duration: number;
  aspectRatio: AspectRatio;
  bitrate?: number;
}

export interface ResolutionSet {
  portrait: Resolution[];
  landscape: Resolution[];
  square: Resolution[];
}

export interface ConversionJob {
  id: string;
  sourceFile: VideoFile;
  targetPath: string;
  options: ConversionOptions;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  startTime?: Date;
  endTime?: Date;
  error?: string;
  outputFiles: string[];
}

export interface MigrationConfig {
  supabase: {
    url: string;
    anonKey: string;
  };
  storage: {
    sourceBucket: string;
    sourceFolder: string;
    targetBucket: string;
    targetFolder: string;
  };
  processing: {
    maxConcurrentJobs: number;
    tempDir: string;
  };
  hls: ConversionOptions;
}

export interface MigrationProgress {
  totalFiles: number;
  processedFiles: number;
  failedFiles: number;
  currentJob?: ConversionJob;
  estimatedTimeRemaining?: number;
}

export interface StorageFile {
  name: string;
  id?: string;
  updated_at?: string;
  created_at?: string;
  last_accessed_at?: string;
  metadata?: Record<string, any>;
}
