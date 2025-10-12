import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { migrationConfig } from '../config/index.js';
import { VideoFile, StorageFile } from '../types/index.js';
import { logger } from '../utils/logger.js';
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
    
    this.adminClient = createClient(
      migrationConfig.supabase.url,
      migrationConfig.supabase.anonKey
    );
  }

  async updatePost(postId: string, data: any): Promise<void> {
    await this.adminClient.from('posts').update(data).eq('id', postId);
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
