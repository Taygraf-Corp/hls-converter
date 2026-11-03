import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { migrationConfig } from '../config/index.js';
import { VideoFile, StorageFile } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { Condition, POST_COLUMNS, PostRow, publishConditions } from './hls-policy.js';
import fs from 'fs/promises';
import path from 'path';

/** Apply publishConditions() to a PostgREST filter builder. */
function applyConditions(q: any, conditions: Condition[]): any {
  const literal = (c: Condition): string => {
    if ('or' in c) {
      throw new Error('nested or is not supported');
    }
    const v = c.op === 'in'
      ? `(${(c.value as string[]).join(',')})`
      : c.value === null ? 'null' : String(c.value);
    return `${String(c.col)}.${c.op}.${v}`;
  };
  for (const c of conditions) {
    if ('or' in c) {
      q = q.or(c.or.map(literal).join(','));
    } else if (c.op === 'eq') {
      q = q.eq(c.col, c.value);
    } else if (c.op === 'gt') {
      q = q.gt(c.col, c.value);
    } else if (c.op === 'is') {
      q = q.is(c.col, c.value);
    } else {
      q = q.in(c.col, c.value);
    }
  }
  return q;
}

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
   * Publish hls_url in one UPDATE that re-applies the complete eligibility
   * policy (publishConditions) and requires that no attempt published first.
   * Returns whether exactly one row was updated. Throws when the database
   * does not answer; the caller must then treat the outcome as unknown.
   */
  async publishHlsUrl(post: PostRow, hlsUrl: string, now: Date = new Date()): Promise<boolean> {
    let q: any = this.adminClient.from('posts').update({ hls_url: hlsUrl });
    q = applyConditions(q, publishConditions(post, now));
    const { data, error } = await q.select('id');
    if (error) {
      throw new Error(`Failed to set hls_url: ${error.message}`);
    }
    return (data ?? []).length === 1;
  }

  /** The row's current hls_url (undefined when the row is gone). */
  async getHlsUrl(postId: string): Promise<string | null | undefined> {
    const { data, error } = await this.adminClient
      .from('posts').select('hls_url').eq('id', postId).maybeSingle();
    if (error) {
      throw new Error(`Failed to read hls_url: ${error.message}`);
    }
    return data ? ((data as { hls_url: string | null }).hls_url ?? null) : undefined;
  }

  /** Clear hls_url if it is still exactly [hlsUrl]. */
  async clearHlsUrl(postId: string, hlsUrl: string): Promise<void> {
    const { error } = await this.adminClient
      .from('posts')
      .update({ hls_url: null })
      .eq('id', postId)
      .eq('hls_url', hlsUrl);
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

  /** Every object under [prefix], recursively, with its last-modified time. */
  async listTree(prefix: string, bucket?: string): Promise<{ path: string; modifiedAt: number }[]> {
    const targetBucket = bucket || migrationConfig.storage.targetBucket;
    const out: { path: string; modifiedAt: number }[] = [];
    const pending = [prefix];
    let calls = 0;
    while (pending.length > 0) {
      const dir = pending.pop() as string;
      for (let offset = 0; ; offset += 1000) {
        if (++calls > 500) {
          throw new Error(`Gave up listing ${prefix}: too many entries`);
        }
        const { data, error } = await this.adminClient.storage
          .from(targetBucket)
          .list(dir, { limit: 1000, offset });
        if (error) {
          throw new Error(`Failed to list ${dir}: ${error.message}`);
        }
        const entries = data ?? [];
        for (const e of entries) {
          if (e.id) {
            const t = Date.parse((e as any).updated_at || (e as any).created_at || '');
            out.push({ path: `${dir}/${e.name}`, modifiedAt: Number.isNaN(t) ? 0 : t });
          } else {
            pending.push(`${dir}/${e.name}`);
          }
        }
        if (entries.length < 1000) break;
      }
    }
    return out;
  }

  /** Remove these objects (in chunks). Returns how many were removed. */
  async removeObjects(paths: string[], bucket?: string): Promise<number> {
    const targetBucket = bucket || migrationConfig.storage.targetBucket;
    let removed = 0;
    for (let i = 0; i < paths.length; i += 500) {
      const chunk = paths.slice(i, i + 500);
      const { error } = await this.adminClient.storage.from(targetBucket).remove(chunk);
      if (error) {
        throw new Error(`Failed to remove objects: ${error.message}`);
      }
      removed += chunk.length;
    }
    return removed;
  }

  /** Remove every object under [prefix], recursively, until none is left. */
  async removeTree(prefix: string, bucket?: string): Promise<number> {
    let removed = 0;
    for (let round = 0; round < 5; round++) {
      const objects = await this.listTree(prefix, bucket);
      if (objects.length === 0) {
        return removed;
      }
      removed += await this.removeObjects(objects.map(o => o.path), bucket);
    }
    throw new Error(`Gave up removing ${prefix}: objects keep reappearing`);
  }

  // Reconcile queue (taygram-backend proposal 20261102130000_hls_reconcile_queue).

  async claimReconcile(limit: number): Promise<{ post_id: string; queued_at: string; attempts: number }[]> {
    const { data, error } = await this.adminClient.rpc('hls_claim_reconcile', { p_limit: limit });
    if (error) {
      throw new Error(`Failed to claim reconcile work: ${error.message}`);
    }
    return (data ?? []) as { post_id: string; queued_at: string; attempts: number }[];
  }

  async completeReconcile(postId: string, queuedAt: string): Promise<void> {
    const { error } = await this.adminClient.rpc('hls_complete_reconcile', { p_post_id: postId, p_queued_at: queuedAt });
    if (error) {
      throw new Error(`Failed to complete reconcile work: ${error.message}`);
    }
  }

  async failReconcile(postId: string, message: string): Promise<void> {
    const { error } = await this.adminClient.rpc('hls_fail_reconcile', { p_post_id: postId, p_error: message });
    if (error) {
      throw new Error(`Failed to record reconcile failure: ${error.message}`);
    }
  }

  /** One recent video post without HLS to convert now, under a lease (hls_claim_autoconvert). */
  async claimAutoconvert(leaseMs: number): Promise<{ post_id: string; attempts: number; claim_token: string } | null> {
    const { data, error } = await this.adminClient.rpc('hls_claim_autoconvert', { p_lease: intervalOf(leaseMs) });
    if (error) {
      throw new Error(`Failed to claim auto-convert work: ${error.message}`);
    }
    const rows = (data ?? []) as { post_id: string; attempts: number; claim_token: string }[];
    return rows[0] ?? null;
  }

  /** Extend this worker's lease; false when the claim is no longer its own. */
  async renewAutoconvert(postId: string, token: string, leaseMs: number): Promise<boolean> {
    const { data, error } = await this.adminClient.rpc('hls_autoconvert_renew', {
      p_post_id: postId, p_claim_token: token, p_lease: intervalOf(leaseMs),
    });
    if (error) {
      throw new Error(`Failed to renew an auto-convert claim: ${error.message}`);
    }
    return data === true;
  }

  /** Record the outcome and release the claim; false when it was not this worker's. */
  async autoconvertResult(postId: string, token: string, message: string | null, final: boolean): Promise<boolean> {
    const { data, error } = await this.adminClient.rpc('hls_autoconvert_result', {
      p_post_id: postId, p_claim_token: token, p_error: message, p_final: final,
    });
    if (error) {
      throw new Error(`Failed to record an auto-convert result: ${error.message}`);
    }
    return data === true;
  }

  async enqueueReconcile(limit: number): Promise<number> {
    const { data, error } = await this.adminClient.rpc('hls_enqueue_reconcile', { p_limit: limit });
    if (error) {
      throw new Error(`Failed to scan for reconcile work: ${error.message}`);
    }
    return Number(data ?? 0);
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
  async uploadHlsFiles(hlsDir: string, baseRemotePath: string, signal?: AbortSignal): Promise<string[]> {
    try {
      const uploadedFiles: string[] = [];
      const files = await fs.readdir(hlsDir, { recursive: true });

      for (const file of files) {
        if (typeof file === 'string') {
          const localFilePath = path.join(hlsDir, file);
          const stat = await fs.stat(localFilePath);
          
          if (stat.isFile()) {
            if (signal?.aborted) {
              throw new Error(`upload cancelled: ${String((signal.reason as Error)?.message ?? signal.reason)}`);
            }
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

/** A PostgreSQL interval for [ms] milliseconds. */
function intervalOf(ms: number): string {
  return `${Math.max(0, Math.round(ms)) / 1000} seconds`;
}
