import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { migrationConfig } from '../config/index.js';
import { VideoFile, StorageFile } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { POST_COLUMNS, PostRow } from './hls-policy.js';
import fs from 'fs/promises';
import path from 'path';

export class SupabaseStorageService {
  private client: SupabaseClient;
  private adminClient: SupabaseClient;

  constructor() {
    this.client = createClient(
      migrationConfig.supabase.url,
      migrationConfig.supabase.anonKey
    );
    
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!serviceRoleKey) {
      throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
    }

    this.adminClient = createClient(
      migrationConfig.supabase.url,
      serviceRoleKey
    );
  }

  /** One post row for the HLS policy (service role). Null when no row matches. */
  async getPostForHls(postId: string): Promise<PostRow | null> {
    const { data, error } = await this.adminClient
      .from('posts')
      .select(POST_COLUMNS)
      .eq('id', postId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to read post: ${error.message}`);
    }
    return (data as PostRow | null) ?? null;
  }

  /** Whether the author has an account-deletion job of any status. */
  async hasDeletionJob(profileId: string | null): Promise<boolean> {
    if (!profileId) {
      return false;
    }
    const { data, error } = await this.adminClient
      .from('account_deletion_jobs')
      .select('id')
      .eq('profile_id', profileId)
      .limit(1);

    if (error) {
      // Unknown must not read as "no deletion": refuse instead.
      throw new Error(`Failed to read account deletion state: ${error.message}`);
    }
    return (data ?? []).length > 0;
  }

  /**
   * Set hls_url only if the row still names the same source and is still
   * eligible at this moment (publication-time recheck, one UPDATE). Returns
   * whether a row was updated.
   */
  async setHlsUrlIfStillEligible(post: PostRow, hlsUrl: string): Promise<boolean> {
    let q = this.adminClient
      .from('posts')
      .update({ hls_url: hlsUrl })
      .eq('id', post.id)
      .or('is_hidden.is.null,is_hidden.eq.false')
      .or('is_vip.is.null,is_vip.eq.false');

    if (post.media_path) {
      q = q
        .eq('media_bucket', post.media_bucket as string)
        .eq('media_path', post.media_path)
        .is('expires_at', null);
    } else {
      q = q.is('media_path', null).eq('video_url', post.video_url as string);
      q = post.expires_at
        ? q.gt('expires_at', new Date().toISOString())
        : q.is('expires_at', null);
    }

    const { data, error } = await q.select('id');
    if (error) {
      throw new Error(`Failed to set hls_url: ${error.message}`);
    }
    return (data ?? []).length === 1;
  }

  /** Clear hls_url when it still points at this post's own folder. */
  async clearHlsUrl(postId: string, folder: string): Promise<void> {
    const { error } = await this.adminClient
      .from('posts')
      .update({ hls_url: null })
      .eq('id', postId)
      .like('hls_url', `%/${folder}/%`);
    if (error) {
      throw new Error(`Failed to clear hls_url: ${error.message}`);
    }
  }

  /**
   * Whether a post other than [postId] plays HLS from [folder]. Older batch
   * migrations named folders after source files, so a folder name alone does
   * not prove which post owns it.
   */
  async otherPostUsesFolder(postId: string, folder: string): Promise<boolean> {
    const { data, error } = await this.adminClient
      .from('posts')
      .select('id')
      .neq('id', postId)
      .like('hls_url', `%/${folder}/%`)
      .limit(1);
    if (error) {
      throw new Error(`Failed to check folder use: ${error.message}`);
    }
    return (data ?? []).length > 0;
  }

  /** Remove every object directly inside [folder] of the target bucket. */
  async removeFolder(folder: string, bucket?: string): Promise<number> {
    const targetBucket = bucket || migrationConfig.storage.targetBucket;
    let removed = 0;
    let rounds = 0;
    for (;;) {
      const { data, error } = await this.adminClient.storage
        .from(targetBucket)
        .list(folder, { limit: 1000 });
      if (error) {
        throw new Error(`Failed to list ${folder}: ${error.message}`);
      }
      const files = (data ?? []).filter(f => f.id).map(f => `${folder}/${f.name}`);
      if (++rounds > 50) {
        throw new Error(`Gave up removing ${folder}: objects keep reappearing`);
      }
      if (files.length === 0) {
        return removed;
      }
      const { error: rmError } = await this.adminClient.storage
        .from(targetBucket)
        .remove(files);
      if (rmError) {
        throw new Error(`Failed to remove from ${folder}: ${rmError.message}`);
      }
      removed += files.length;
    }
  }

  /**
   * List all MP4 files in the source bucket
   */
  async listMp4Files(): Promise<VideoFile[]> {
    try {
      const { data, error } = await this.adminClient.storage
        .from(migrationConfig.storage.sourceBucket)
        .list(migrationConfig.storage.sourceFolder, {
          limit: 1000,
          sortBy: { column: 'name', order: 'asc' }
        });

      if (error) {
        throw new Error(`Failed to list files: ${error.message}`);
      }

      const mp4Files = data
        .filter((file: StorageFile) => 
          file.name.toLowerCase().endsWith('.mp4') && 
          file.metadata?.size > 0
        )
        .map((file: StorageFile): VideoFile => ({
          name: file.name,
          path: `${migrationConfig.storage.sourceFolder}/${file.name}`,
          size: file.metadata?.size || 0,
          bucket: migrationConfig.storage.sourceBucket,
          lastModified: file.updated_at ? new Date(file.updated_at) : undefined,
          metadata: file.metadata
        }));

      logger.info(`Found ${mp4Files.length} MP4 files in bucket ${migrationConfig.storage.sourceBucket}`);
      return mp4Files;
    } catch (error) {
      logger.error('Error listing MP4 files:', error);
      throw error;
    }
  }

  /**
   * Download a file from Supabase storage to local filesystem
   */
  async downloadFile(videoFile: VideoFile, localPath: string): Promise<void> {
    try {
      const { data, error } = await this.adminClient.storage
        .from(videoFile.bucket)
        .download(videoFile.path);

      if (error) {
        throw new Error(`Failed to download ${videoFile.name}: ${error.message}`);
      }

      if (!data) {
        throw new Error(`No data received for ${videoFile.name}`);
      }

      // Ensure directory exists
      await fs.mkdir(path.dirname(localPath), { recursive: true });

      // Convert blob to buffer and write to file
      const buffer = Buffer.from(await data.arrayBuffer());
      await fs.writeFile(localPath, buffer);

      logger.info(`Downloaded ${videoFile.name} to ${localPath}`);
    } catch (error) {
      logger.error(`Error downloading ${videoFile.name}:`, error);
      throw error;
    }
  }

  /**
   * Upload a file to Supabase storage
   */
  async uploadFile(localPath: string, remotePath: string, bucket?: string): Promise<void> {
    try {
      const targetBucket = bucket || migrationConfig.storage.targetBucket;
      const fileBuffer = await fs.readFile(localPath);

      const { error } = await this.adminClient.storage
        .from(targetBucket)
        .upload(remotePath, fileBuffer, {
          cacheControl: '3600',
          upsert: true
        });

      if (error) {
        throw new Error(`Failed to upload ${remotePath}: ${error.message}`);
      }

      logger.info(`Uploaded ${localPath} to ${targetBucket}/${remotePath}`);
    } catch (error) {
      logger.error(`Error uploading ${remotePath}:`, error);
      throw error;
    }
  }

  /**
   * Upload multiple files (HLS segments and playlists)
   */
  async uploadHlsFiles(hlsDir: string, baseRemotePath: string): Promise<string[]> {
    try {
      const uploadedFiles: string[] = [];
      const files = await fs.readdir(hlsDir, { recursive: true });

      for (const file of files) {
        if (typeof file === 'string') {
          const localFilePath = path.join(hlsDir, file);
          const stat = await fs.stat(localFilePath);
          
          if (stat.isFile()) {
            const remotePath = path.join(baseRemotePath, file).replace(/\\/g, '/');
            await this.uploadFile(localFilePath, remotePath);
            uploadedFiles.push(remotePath);
          }
        }
      }

      logger.info(`Uploaded ${uploadedFiles.length} HLS files for ${baseRemotePath}`);
      return uploadedFiles;
    } catch (error) {
      logger.error(`Error uploading HLS files for ${baseRemotePath}:`, error);
      throw error;
    }
  }

  /**
   * Check if a file exists in storage
   */
  async fileExists(filePath: string, bucket?: string): Promise<boolean> {
    try {
      const targetBucket = bucket || migrationConfig.storage.targetBucket;
      const { data, error } = await this.adminClient.storage
        .from(targetBucket)
        .list(path.dirname(filePath), {
          search: path.basename(filePath)
        });

      if (error) {
        return false;
      }

      return data.some(file => file.name === path.basename(filePath));
    } catch (error) {
      logger.error(`Error checking if file exists ${filePath}:`, error);
      return false;
    }
  }

  /**
   * Delete a file from storage
   */
  async deleteFile(filePath: string, bucket?: string): Promise<void> {
    try {
      const targetBucket = bucket || migrationConfig.storage.targetBucket;
      const { error } = await this.adminClient.storage
        .from(targetBucket)
        .remove([filePath]);

      if (error) {
        throw new Error(`Failed to delete ${filePath}: ${error.message}`);
      }

      logger.info(`Deleted ${filePath} from ${targetBucket}`);
    } catch (error) {
      logger.error(`Error deleting ${filePath}:`, error);
      throw error;
    }
  }
}
