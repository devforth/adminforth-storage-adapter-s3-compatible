import type { KeyValueAdapter } from "adminforth";

/**
 * Configuration for S3-compatible storage providers (AWS S3, Cloudflare R2, MinIO, etc.).
 */
export interface AdapterOptions {
  /**
   * Provider region used for request signing.
   * Use AWS region for S3 (for example: "eu-central-1").
   * For Cloudflare R2, use "auto".
   */
  region: string;

  /**
   * Bucket name where files are stored.
   */
  bucket: string;

  /**
   * Access key ID for your S3-compatible provider.
   */
  accessKeyId: string;

  /**
   * Secret access key for your S3-compatible provider.
   */
  secretAccessKey: string;

  /**
   * Object ACL used when uploading files.
   * Common values:
   * - "private": files are accessible only via signed URLs.
   * - "public-read": files can be served as public URLs.
   */
  s3ACL?: 'private' | 'public-read';

  /**
   * Custom S3 endpoint URL.
   * Required for most S3-compatible providers (for example Cloudflare R2).
   * Example: "https://<account-id>.r2.cloudflarestorage.com"
   */
  endpoint?: string;

  /**
   * Enables path-style addressing.
   * true  -> https://endpoint/bucket/key
   * false -> https://bucket.endpoint/key
   *
   * Usually true for R2 and many non-AWS S3 services.
   */
  forcePathStyle?: boolean;

  /**
   * Optional base URL used to build public file links when s3ACL is "public-read".
   * Useful when files are served through a public R2 domain or CDN.
   * Example: "https://pub-<id>.r2.dev"
   */
  publicBaseUrl?: string;

  /**
   * Key-value storage for cleanup markers.
   *
   * This adapter writes cleanup intents here instead of using S3 object tags:
   * - markKeyForDeletion   -> clean=true||<iso-date>||<file-key>
   * - markKeyForNotDeletion -> clean=false||<file-key>
   *
   * A separate scheduler/worker is expected to process these markers later.
   */
  cleanupKeyValueAdapter: KeyValueAdapter;
}