import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

/**
 * API Key Authentication Middleware
 * 
 * Validates API key from request headers or query parameters.
 * Uses API_KEY environment variable for authentication.
 */

interface AuthRequest extends Request {
  authenticated?: boolean;
}

const API_KEY = process.env.API_KEY;

/**
 * Check if API key authentication is enabled
 */
export function isAuthEnabled(): boolean {
  return !!API_KEY;
}

/**
 * Extract API key from request
 * Supports multiple methods:
 * 1. Authorization header: "Bearer <api-key>"
 * 2. X-API-Key header: "<api-key>"
 * 3. Query parameter: ?api_key=<api-key>
 */
function extractApiKey(req: Request): string | null {
  // Method 1: Authorization header with Bearer token
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // Method 2: X-API-Key header
  const apiKeyHeader = req.headers['x-api-key'] as string;
  if (apiKeyHeader) {
    return apiKeyHeader;
  }

  // Method 3: Query parameter
  const apiKeyQuery = req.query.api_key as string;
  if (apiKeyQuery) {
    return apiKeyQuery;
  }

  return null;
}

/**
 * Validate API key
 */
function validateApiKey(apiKey: string): boolean {
  return apiKey === API_KEY;
}

/**
 * Authentication middleware
 * Validates API key and marks request as authenticated
 */
export function authenticate(req: AuthRequest, res: Response, next: NextFunction): void {
  // Skip authentication if not enabled
  if (!isAuthEnabled()) {
    return next();
  }

  const apiKey = extractApiKey(req);

  // Check if API key is provided
  if (!apiKey) {
    logger.warn(`Authentication failed: No API key provided from ${req.ip}`);
    res.status(401).json({
      success: false,
      error: 'Authentication required',
      message: 'Please provide a valid API key via Authorization header, X-API-Key header, or api_key query parameter'
    });
    return;
  }

  // Validate API key
  const isValid = validateApiKey(apiKey);
  
  if (!isValid) {
    logger.warn(`Authentication failed: Invalid API key from ${req.ip}`);
    res.status(401).json({
      success: false,
      error: 'Invalid API key',
      message: 'The provided API key is not valid'
    });
    return;
  }

  // Mark request as authenticated
  req.authenticated = true;
  logger.info(`Authenticated request from ${req.ip}`);
  next();
}

/**
 * Optional authentication middleware
 * Validates API key if provided, but doesn't require it
 */
export function optionalAuthenticate(req: AuthRequest, res: Response, next: NextFunction): void {
  // Skip if auth not enabled
  if (!isAuthEnabled()) {
    return next();
  }

  const apiKey = extractApiKey(req);

  // If no API key provided, continue without authentication
  if (!apiKey) {
    return next();
  }

  // If API key provided, validate it
  const isValid = validateApiKey(apiKey);
  
  if (isValid) {
    req.authenticated = true;
    logger.info(`Authenticated request from ${req.ip}`);
  } else {
    logger.warn(`Invalid API key attempted from ${req.ip}`);
  }

  next();
}

/**
 * Generate a secure API key
 */
export function generateApiKey(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const length = 32;
  let result = '';
  
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  return result;
}
