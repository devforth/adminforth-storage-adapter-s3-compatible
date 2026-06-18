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
   * Key-value storage for cleanup markers. Cleanup markers are used to track files in temporary state, which were uploaded via presign URLs 
   * but not yet commited on UI by calling "Save" button on create or update form. 
   * This is required for S3-compatible providers that do not support object tagging (like Cloudflare R2).
   * Original s3 adapter does not need it because it uses S3 object tags for cleanup markers, but most of s3-compatible providers do not support object tagging, so this adapter uses a key-value storage for cleanup markers instead.
   * 
   * If keys are lost in this key-value storage (e.g. due to non-persisteed KV-storage), the risk is that some files may be left in the bucket when not linked to any record in the database.
   * So in case of losing there might be under-cleanup but never over-cleanup files in the bucket.
   * 
   * Anyway we recommend using a persistent key-value storage for cleanup markers to keep the bucket clean and avoid unnecessary costs for storing unlinked files.
   *
   */
  cleanupKeyValueAdapter: KeyValueAdapter;

  /**
   * Optional interval for checking cleanup markers.
   * Default: "1h" (1 hour)
   */
  cleanupCheckInterval?: string;

  /**
   * Optional grace period for cleanup markers.
   * Files marked for deletion will be deleted only after this period has passed.
   * Default: "7d" (7 days)
   */
  cleanupGracePeriod?: string; 

}