#!/usr/bin/env node

/**
 * Admin Script: Sync HLS URLs to Posts
 * 
 * This script traverses all HLS files in storage and updates corresponding posts
 * with their HLS master playlist URLs.
 * 
 * Usage: npm run sync-hls-urls
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import path from 'path';

config();

// Configuration
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const TARGET_BUCKET = process.env.TARGET_BUCKET || 'FlutterFlow';
const TARGET_FOLDER = process.env.TARGET_FOLDER || 'converted';
const PUBLIC_STORAGE_BASE_URL = process.env.PUBLIC_STORAGE_BASE_URL || 
  'https://ohfzckfunpsjncjjzfyz.supabase.co/storage/v1/object/public/FlutterFlow/';

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

interface SyncResult {
  totalHlsFiles: number;
  postsFound: number;
  postsUpdated: number;
  errors: string[];
  skipped: string[];
}

/**
 * Extract original video filename from HLS path
 * e.g., "converted/1736606618523/hls/master.m3u8" -> "1736606618523.mp4"
 */
function extractVideoFilename(hlsPath: string): string | null {
  // Pattern: converted/{filename}/hls/master.m3u8
  // We want to extract the filename and add .mp4
  const parts = hlsPath.split('/');
  
  // Find the part before "/hls"
  const hlsIndex = parts.indexOf('hls');
  if (hlsIndex > 0) {
    const videoId = parts[hlsIndex - 1];
    // Remove any file extensions and add .mp4
    const baseId = videoId.replace(/\.(mp4|mov|avi|webm|mkv)$/i, '');
    return `${baseId}.mp4`;
  }
  
  return null;
}

/**
 * Find post by video URL containing filename
 */
async function findPostByVideoUrl(filename: string): Promise<any | null> {
  try {
    // Search for posts where video_url contains the filename
    const { data, error } = await supabase
      .from('posts')
      .select('*')
      .ilike('video_url', `%${filename}%`)
      .limit(1)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // No rows found
        return null;
      }
      throw error;
    }

    return data;
  } catch (error) {
    console.error(`Error finding post for ${filename}:`, error);
    return null;
  }
}

/**
 * Update post with HLS URL
 */
async function updatePostHlsUrl(postId: string, hlsUrl: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('posts')
      .update({ hls_url: hlsUrl })
      .eq('id', postId);

    if (error) {
      throw error;
    }

    return true;
  } catch (error) {
    console.error(`Error updating post ${postId}:`, error);
    return false;
  }
}

/**
 * List all HLS master playlists in storage
 */
async function listHlsFiles(): Promise<string[]> {
  const hlsPaths: string[] = [];
  
  try {
    console.log(`📁 Scanning bucket: ${TARGET_BUCKET}/${TARGET_FOLDER}`);
    console.log(`⏳ This may take a moment...\n`);
    
    // List all folders in the target folder (these should be video IDs)
    const { data: videoFolders, error } = await supabase.storage
      .from(TARGET_BUCKET)
      .list(TARGET_FOLDER, {
        limit: 1000,
        sortBy: { column: 'name', order: 'asc' }
      });

    if (error) {
      throw error;
    }

    if (!videoFolders || videoFolders.length === 0) {
      console.log('⚠️  No folders found in storage');
      return [];
    }

    console.log(`📂 Found ${videoFolders.length} folders, checking for HLS files...`);

    // For each video folder, look for hls/master.m3u8
    let checked = 0;
    let foundCount = 0;
    
    // Debug: show first few folders
    if (videoFolders.length > 0) {
      console.log(`\n🔍 First few folders found:`);
      videoFolders.slice(0, 3).forEach(f => {
        console.log(`   - ${f.name} (${f.id ? 'file' : 'folder'})`);
      });
      console.log('');
    }
    
    for (const folder of videoFolders) {
      if (folder.id) continue; // Skip if it's a file
      if (folder.name === '.emptyFolderPlaceholder') continue;

      checked++;
      if (checked % 10 === 0) {
        console.log(`   Checked ${checked}/${videoFolders.length} folders... (found ${foundCount} HLS files)`);
      }

      // Check if hls/master.m3u8 exists in this folder
      const hlsPath = `${TARGET_FOLDER}/${folder.name}/hls`;
      
      // Debug first folder
      if (checked === 1) {
        console.log(`\n🔍 Checking first folder: ${folder.name}`);
        console.log(`   Looking in: ${TARGET_BUCKET}/${hlsPath}`);
      }
      
      try {
        const { data: hlsFiles, error: hlsError } = await supabase.storage
          .from(TARGET_BUCKET)
          .list(hlsPath, {
            limit: 100
          });

        // Debug first folder result
        if (checked === 1) {
          if (hlsError) {
            console.log(`   ❌ Error: ${hlsError.message}`);
          } else if (!hlsFiles || hlsFiles.length === 0) {
            console.log(`   ⚠️  No files found in hls folder`);
          } else {
            console.log(`   ✅ Found ${hlsFiles.length} files:`);
            hlsFiles.slice(0, 5).forEach(f => console.log(`      - ${f.name}`));
          }
          console.log('');
        }

        if (!hlsError && hlsFiles) {
          const masterPlaylist = hlsFiles.find(f => f.name === 'master.m3u8');
          if (masterPlaylist) {
            hlsPaths.push(`${hlsPath}/master.m3u8`);
            foundCount++;
            
            // Show first found playlist
            if (foundCount === 1) {
              console.log(`\n✅ First HLS found: ${hlsPath}/master.m3u8\n`);
            }
          }
        }
      } catch (err) {
        // Folder might not have hls subfolder, continue
        if (checked === 1) {
          console.log(`   ❌ Exception: ${err}\n`);
        }
        continue;
      }
    }

    console.log(`✅ Found ${hlsPaths.length} HLS master playlists\n`);
    return hlsPaths;

  } catch (error) {
    console.error('❌ Error listing HLS files:', error);
    return [];
  }
}

/**
 * Main sync function
 */
async function syncHlsUrls(dryRun: boolean = false): Promise<SyncResult> {
  const result: SyncResult = {
    totalHlsFiles: 0,
    postsFound: 0,
    postsUpdated: 0,
    errors: [],
    skipped: []
  };

  console.log('🚀 Starting HLS URL sync...\n');
  
  if (dryRun) {
    console.log('🔍 DRY RUN MODE - No changes will be made\n');
  }

  // Get all HLS files
  const hlsPaths = await listHlsFiles();
  result.totalHlsFiles = hlsPaths.length;

  if (hlsPaths.length === 0) {
    console.log('⚠️  No HLS files found. Nothing to sync.');
    return result;
  }

  console.log('\n📊 Processing HLS files...\n');

  // Process each HLS file
  for (const hlsPath of hlsPaths) {
    const filename = extractVideoFilename(hlsPath);
    
    if (!filename) {
      result.skipped.push(`Could not extract filename from: ${hlsPath}`);
      console.log(`⏭️  Skipped: ${hlsPath} (could not extract filename)`);
      continue;
    }

    console.log(`\n🔍 Processing: ${filename}`);
    console.log(`   HLS Path: ${hlsPath}`);

    // Find corresponding post
    const post = await findPostByVideoUrl(filename);

    if (!post) {
      result.skipped.push(`No post found for: ${filename}`);
      console.log(`   ⚠️  No post found with video_url containing: ${filename}`);
      continue;
    }

    result.postsFound++;
    console.log(`   ✅ Found post: ${post.id}`);
    console.log(`   📹 Video URL: ${post.video_url}`);

    // Construct HLS URL
    const hlsUrl = `${PUBLIC_STORAGE_BASE_URL}${hlsPath}`;
    console.log(`   🎬 HLS URL: ${hlsUrl}`);

    // Check if already up to date
    if (post.hls_url === hlsUrl) {
      result.skipped.push(`Post ${post.id} already has correct HLS URL`);
      console.log(`   ℹ️  Already up to date`);
      continue;
    }

    // Update post
    if (!dryRun) {
      const success = await updatePostHlsUrl(post.id, hlsUrl);
      
      if (success) {
        result.postsUpdated++;
        console.log(`   ✅ Updated post ${post.id}`);
      } else {
        result.errors.push(`Failed to update post ${post.id}`);
        console.log(`   ❌ Failed to update post ${post.id}`);
      }
    } else {
      console.log(`   🔍 Would update post ${post.id} (dry run)`);
      result.postsUpdated++; // Count what would be updated
    }
  }

  return result;
}

/**
 * Print summary
 */
function printSummary(result: SyncResult, dryRun: boolean) {
  console.log('\n' + '='.repeat(60));
  console.log('📊 SYNC SUMMARY');
  console.log('='.repeat(60));
  console.log(`\n📁 Total HLS files found: ${result.totalHlsFiles}`);
  console.log(`🔍 Posts found: ${result.postsFound}`);
  console.log(`✅ Posts ${dryRun ? 'to be updated' : 'updated'}: ${result.postsUpdated}`);
  console.log(`⏭️  Skipped: ${result.skipped.length}`);
  console.log(`❌ Errors: ${result.errors.length}`);

  if (result.skipped.length > 0) {
    console.log('\n⏭️  Skipped items:');
    result.skipped.forEach(item => console.log(`   - ${item}`));
  }

  if (result.errors.length > 0) {
    console.log('\n❌ Errors:');
    result.errors.forEach(error => console.log(`   - ${error}`));
  }

  console.log('\n' + '='.repeat(60));
}

/**
 * Main execution
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || args.includes('-d');
  const help = args.includes('--help') || args.includes('-h');

  if (help) {
    console.log(`
HLS URL Sync Script

Usage: npm run sync-hls-urls [options]

Options:
  --dry-run, -d    Run without making changes (preview mode)
  --help, -h       Show this help message

Environment Variables:
  SUPABASE_URL              Supabase project URL
  SUPABASE_ANON_KEY         Supabase anon key
  TARGET_BUCKET             Storage bucket (default: FlutterFlow)
  TARGET_FOLDER             Storage folder (default: converted)
  PUBLIC_STORAGE_BASE_URL   Base URL for HLS files

Examples:
  npm run sync-hls-urls              # Sync all HLS URLs
  npm run sync-hls-urls -- --dry-run # Preview changes
    `);
    process.exit(0);
  }

  try {
    // Validate environment
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error('Missing required environment variables: SUPABASE_URL, SUPABASE_ANON_KEY');
    }

    // Run sync
    const result = await syncHlsUrls(dryRun);
    
    // Print summary
    printSummary(result, dryRun);

    if (dryRun) {
      console.log('\n💡 Run without --dry-run to apply changes');
    } else {
      console.log('\n🎉 Sync completed!');
    }

    process.exit(0);

  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { syncHlsUrls, findPostByVideoUrl, updatePostHlsUrl };

