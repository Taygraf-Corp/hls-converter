#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { HlsConverterStack } from '../lib/hls-converter-stack';

// Load .env from parent directory (project root)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const app = new cdk.App();

// Get environment from context or use defaults
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID,
  region: process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || 'us-east-1',
};

// Configuration from environment variables or context
const config = {
  // Supabase configuration
  supabaseUrl: app.node.tryGetContext('supabaseUrl') || process.env.SUPABASE_URL,
  supabaseAnonKey: app.node.tryGetContext('supabaseAnonKey') || process.env.SUPABASE_ANON_KEY,
  apiKey: app.node.tryGetContext('apiKey') || process.env.API_KEY,
  
  // Storage configuration
  sourceBucket: app.node.tryGetContext('sourceBucket') || process.env.SOURCE_BUCKET || 'FlutterFlow',
  targetBucket: app.node.tryGetContext('targetBucket') || process.env.TARGET_BUCKET || 'FlutterFlow',
  targetFolder: app.node.tryGetContext('targetFolder') || process.env.TARGET_FOLDER || 'converted',
  
  // Scaling configuration
  minCapacity: parseInt(app.node.tryGetContext('minCapacity') || '1'),
  maxCapacity: parseInt(app.node.tryGetContext('maxCapacity') || '5'),
  cpu: parseInt(app.node.tryGetContext('cpu') || '2048'),
  memory: parseInt(app.node.tryGetContext('memory') || '4096'),
};

new HlsConverterStack(app, 'HlsConverterStack', {
  env,
  config,
  description: 'HLS Video Conversion Service - ECS Fargate deployment',
  tags: {
    Project: 'hls-converter',
    Environment: 'production',
    ManagedBy: 'cdk',
  },
});

app.synth();
