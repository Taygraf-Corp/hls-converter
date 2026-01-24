#!/usr/bin/env node

/**
 * Batch Convert Posts to HLS
 * 
 * This script finds all posts with video_url but no hls_url and triggers
 * HLS conversion for each one via the API.
 * 
 * Usage: npm run batch-convert [-- --dry-run] [-- --limit N]
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import http from 'http';
import https from 'https';

config();

// Configuration
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const HLS_SERVICE_URL = process.env.HLS_SERVICE_URL || 'http://localhost:3000';
const HLS_API_KEY = process.env.HLS_API_KEY || process.env.API_KEY!;
const SOURCE_BUCKET = process.env.SOURCE_BUCKET || 'FlutterFlow';
const DEFAULT_CONCURRENCY = 4; // Process 3 videos at a time by defaul

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

interface BatchConvertResult {
  totalPosts: number;
  triggered: number;
  failed: number;
  skipped: number;
  errors: Array<{ postId: string; error: string }>;
}

interface Post {
  id: string;
  video_url: string;
  hls_url: string | null;
  created_at: string;
}

/**
 * Extract video path from full Supabase URL
 * Example: https://ohfzckfunpsjncjjzfyz.supabase.co/storage/v1/object/public/FlutterFlow/Videos/1234567890.mp4
 * Returns: Videos/1234567890.mp4
 */
function extractVideoPath(videoUrl: string): { path: string; bucket: string } | null {
  try {
    const uri = new URL(videoUrl);
    const pathSegments = uri.pathname.split('/').filter(s => s);
    
    // Find the index of 'public' segment
    const publicIndex = pathSegments.indexOf('public');
    if (publicIndex === -1 || publicIndex + 2 >= pathSegments.length) {
      console.error(`   ❌ Invalid video URL format: ${videoUrl}`);
      return null;
    }
    
    // Skip 'public' and bucket name to get the actual file path
    const videoPath = pathSegments.slice(publicIndex + 2).join('/');
    const bucket = pathSegments[publicIndex + 1];
    
    return { path: videoPath, bucket };
  } catch (error) {
    console.error(`   ❌ Error parsing URL: ${videoUrl}`, error);
    return null;
  }
}

/**
 * Get all posts that need HLS conversion
 */
async function getPostsNeedingConversion(limit?: number): Promise<Post[]> {
  try {
    console.log('🔍 Querying posts that need HLS conversion...');
    
    let query = supabase
      .from('posts')
      .select('id, video_url, hls_url, created_at')
      .not('video_url', 'is', null)
      .is('hls_url', null)
      .order('created_at', { ascending: false });
    
    if (limit) {
      query = query.limit(limit);
    }
    
    const { data, error } = await query;
    
    if (error) {
      throw error;
    }
    
    console.log(`✅ Found ${data?.length || 0} posts needing conversion\n`);
    return data || [];
  } catch (error) {
    console.error('❌ Error querying posts:', error);
    throw error;
  }
}

/**
 * Trigger HLS conversion for a single post
 */
async function triggerConversion(post: Post): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const videoInfo = extractVideoPath(post.video_url);
      
      if (!videoInfo) {
        console.error(`   ❌ Could not extract video path from: ${post.video_url}`);
        resolve(false);
        return;
      }
      
      const url = new URL(`${HLS_SERVICE_URL}/api/process-from-storage`);
      const requestLib = url.protocol === 'https:' ? https : http;
      
      const postData = JSON.stringify({
        videoPath: videoInfo.path,
        bucket: videoInfo.bucket,
        postId: post.id,
        videoId: post.id
      });
      
      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${HLS_API_KEY}`,
          'Content-Length': Buffer.byteLength(postData)
        }
      };
      
      const req = requestLib.request(url, options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode === 200) {
            console.log(`   ✅ Triggered conversion successfully`);
            resolve(true);
          } else {
            console.error(`   ❌ Failed with status ${res.statusCode}: ${data}`);
            resolve(false);
          }
        });
      });
      
      req.on('error', (error) => {
        console.error(`   ❌ Request error:`, error.message);
        resolve(false);
      });
      
      req.write(postData);
      req.end();
      
    } catch (error) {
      console.error(`   ❌ Exception:`, error);
      resolve(false);
    }
  });
}

/**
 * Process a single post and return result
 */
async function processPost(
  post: Post,
  index: number,
  total: number,
  dryRun: boolean
): Promise<{ success: boolean; postId: string; error?: string }> {
  const progress = `[${index + 1}/${total}]`;
  
  console.log(`\n${progress} Post: ${post.id}`);
  console.log(`   📹 Video: ${post.video_url.split('/').pop()}`);
  
  if (dryRun) {
    console.log(`   🔍 Would trigger conversion (dry run)`);
    return { success: true, postId: post.id };
  }
  
  const success = await triggerConversion(post);
  
  if (!success) {
    return { success: false, postId: post.id, error: 'Failed to trigger conversion' };
  }
  
  return { success: true, postId: post.id };
}

/**
 * Main batch conversion function
 */
async function batchConvertPosts(
  dryRun: boolean = false,
  limit?: number,
  concurrency: number = DEFAULT_CONCURRENCY
): Promise<BatchConvertResult> {
  const result: BatchConvertResult = {
    totalPosts: 0,
    triggered: 0,
    failed: 0,
    skipped: 0,
    errors: []
  };
  
  console.log('🚀 Starting batch HLS conversion...\n');
  console.log(`📡 HLS Service: ${HLS_SERVICE_URL}`);
  console.log(`📁 Source Bucket: ${SOURCE_BUCKET}`);
  console.log(`⚡ Concurrency: ${concurrency} parallel jobs\n`);
  
  if (dryRun) {
    console.log('🔍 DRY RUN MODE - No conversions will be triggered\n');
  }
  
  // Get posts needing conversion
  const posts = await getPostsNeedingConversion(limit);
  result.totalPosts = posts.length;
  
  if (posts.length === 0) {
    console.log('✨ All posts already have HLS URLs! Nothing to convert.');
    return result;
  }
  
  console.log('📊 Processing posts...\n');
  console.log('='.repeat(60));
  
  // Process posts in parallel batches
  const total = posts.length;
  let completed = 0;
  
  for (let i = 0; i < posts.length; i += concurrency) {
    const batch = posts.slice(i, i + concurrency);
    
    // Process batch in parallel
    const batchPromises = batch.map((post, batchIndex) =>
      processPost(post, i + batchIndex, total, dryRun)
    );
    
    const batchResults = await Promise.all(batchPromises);
    
    // Collect results
    for (const batchResult of batchResults) {
      completed++;
      if (batchResult.success) {
        result.triggered++;
      } else {
        result.failed++;
        result.errors.push({
          postId: batchResult.postId,
          error: batchResult.error || 'Unknown error'
        });
      }
    }
    
    // Show batch progress
    const pct = ((completed / total) * 100).toFixed(1);
    console.log(`\n📈 Progress: ${completed}/${total} (${pct}%) - ✅ ${result.triggered} triggered, ❌ ${result.failed} failed`);
  }
  
  return result;
}

/**
 * Print summary
 */
function printSummary(result: BatchConvertResult, dryRun: boolean) {
  console.log('\n' + '='.repeat(60));
  console.log('📊 BATCH CONVERSION SUMMARY');
  console.log('='.repeat(60));
  console.log(`\n📁 Total posts needing conversion: ${result.totalPosts}`);
  console.log(`✅ Conversions ${dryRun ? 'would be' : ''} triggered: ${result.triggered}`);
  console.log(`❌ Failed: ${result.failed}`);
  console.log(`⏭️  Skipped: ${result.skipped}`);
  
  if (result.errors.length > 0) {
    console.log('\n❌ Errors:');
    result.errors.forEach(({ postId, error }) => {
      console.log(`   - Post ${postId}: ${error}`);
    });
  }
  
  console.log('\n' + '='.repeat(60));
  
  if (!dryRun && result.triggered > 0) {
    console.log('\n💡 Tip: Monitor the conversion progress with:');
    console.log('   aws logs tail /ecs/hls-converter --follow --region ca-central-1');
  }
}

/**
 * Main execution
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || args.includes('-d');
  const help = args.includes('--help') || args.includes('-h');
  
  let limit: number | undefined;
  const limitIndex = args.findIndex(arg => arg === '--limit' || arg === '-l');
  if (limitIndex !== -1 && args[limitIndex + 1]) {
    limit = parseInt(args[limitIndex + 1]);
    if (isNaN(limit)) {
      console.error('❌ Invalid limit value');
      process.exit(1);
    }
  }
  
  let concurrency = DEFAULT_CONCURRENCY;
  const concurrencyIndex = args.findIndex(arg => arg === '--concurrency' || arg === '-c');
  if (concurrencyIndex !== -1 && args[concurrencyIndex + 1]) {
    concurrency = parseInt(args[concurrencyIndex + 1]);
    if (isNaN(concurrency) || concurrency < 1) {
      console.error('❌ Invalid concurrency value (must be >= 1)');
      process.exit(1);
    }
  }
  
  if (help) {
    console.log(`
Batch HLS Conversion Script

Usage: npm run batch-convert [options]

Options:
  --dry-run, -d           Run without triggering conversions (preview mode)
  --limit N, -l N         Process only the first N posts
  --concurrency N, -c N   Number of parallel conversions (default: 3)
  --help, -h              Show this help message

Environment Variables:
  SUPABASE_URL        Supabase project URL
  SUPABASE_ANON_KEY   Supabase anon key
  HLS_SERVICE_URL     HLS conversion service URL (default: http://localhost:3000)
  API_KEY             API key for HLS service (or HLS_API_KEY)
  SOURCE_BUCKET       Storage bucket (default: FlutterFlow)

Examples:
  npm run batch-convert                       # Convert all posts (3 parallel)
  npm run batch-convert -- --dry-run          # Preview what would be converted
  npm run batch-convert -- --limit 5          # Convert only first 5 posts
  npm run batch-convert -- -c 5               # Use 5 parallel conversions
  npm run batch-convert -- -c 10 -l 50        # 10 parallel, first 50 posts
    `);
    process.exit(0);
  }
  
  try {
    // Validate environment
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error('Missing required environment variables: SUPABASE_URL, SUPABASE_ANON_KEY');
    }
    
    if (!dryRun && !HLS_API_KEY) {
      throw new Error('Missing required environment variable: HLS_API_KEY or API_KEY');
    }
    
    if (limit) {
      console.log(`⚙️  Limit: Processing only first ${limit} posts`);
    }
    console.log(`⚡ Concurrency: ${concurrency} parallel jobs\n`);
    
    // Run batch conversion
    const result = await batchConvertPosts(dryRun, limit, concurrency);
    
    // Print summary
    printSummary(result, dryRun);
    
    if (dryRun) {
      console.log('\n💡 Run without --dry-run to trigger actual conversions');
    } else {
      console.log('\n🎉 Batch conversion triggered!');
      console.log('   Conversions are now processing asynchronously.');
      console.log('   Posts will be updated with hls_url when complete.');
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

export { batchConvertPosts, getPostsNeedingConversion };
