#!/usr/bin/env tsx

/**
 * Generate secure API key for authentication
 */

import crypto from 'crypto';

function generateApiKey(): string {
  // Generate a secure random key using crypto
  return crypto.randomBytes(32).toString('base64url');
}

const apiKey = generateApiKey();

console.log('\n🔑 Generated API Key\n');
console.log('═'.repeat(70));
console.log('\n' + apiKey);
console.log('\n' + '═'.repeat(70));
console.log('\n📋 Add to your .env file:\n');
console.log(`API_KEY=${apiKey}`);
console.log('\n' + '═'.repeat(70));
console.log('\n💡 Usage in requests:\n');
console.log('Method 1 - Authorization Header:');
console.log(`  curl -H "Authorization: Bearer ${apiKey}" ...`);
console.log('\nMethod 2 - X-API-Key Header:');
console.log(`  curl -H "X-API-Key: ${apiKey}" ...`);
console.log('\nMethod 3 - Query Parameter:');
console.log(`  curl "http://localhost:3000/api/upload?api_key=${apiKey}" ...`);
console.log('');
