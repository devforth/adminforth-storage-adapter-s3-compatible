import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ObjectCannedACL,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from 'stream';

import type { StorageAdapter } from "adminforth";
import { afLogger } from "adminforth";
import type { AdapterOptions } from "./types.js";

export default class AdminForthAdapterS3Storage implements StorageAdapter {
  protected s3: S3Client;
  protected options: AdapterOptions;

  constructor(options: AdapterOptions) {
    this.options = options;
  }

  protected getClient(): S3Client {
    if (!this.s3) {
      this.s3 = new S3Client({
        region: this.options.region,
        endpoint: this.options.endpoint,
        forcePathStyle: this.options.forcePathStyle,
        credentials: {
          accessKeyId: this.options.accessKeyId,
          secretAccessKey: this.options.secretAccessKey,
        },
      });
    }

    return this.s3;
  }

  protected getCleanupDeletionMarkKey(key: string): string {
    return `clean=true||${new Date().toISOString()}||${key}`;
  }

  protected getCleanupNotDeletionMarkKey(key: string): string {
    return `clean=false||${key}`;
  }

  protected encodeKeyForUrl(key: string): string {
    return key.split('/').map(encodeURIComponent).join('/');
  }

  protected buildPublicObjectUrl(key: string): string {
    const encodedKey = this.encodeKeyForUrl(key);
    const normalizedPublicBaseUrl = this.options.publicBaseUrl?.replace(/\/$/, '');
    if (normalizedPublicBaseUrl) {
      return `${normalizedPublicBaseUrl}/${encodedKey}`;
    }

    const normalizedEndpoint = this.options.endpoint?.replace(/\/$/, '');
    if (normalizedEndpoint) {
      if (this.options.forcePathStyle) {
        return `${normalizedEndpoint}/${this.options.bucket}/${encodedKey}`;
      }

      const endpointUrl = new URL(normalizedEndpoint);
      return `${endpointUrl.protocol}//${this.options.bucket}.${endpointUrl.host}/${encodedKey}`;
    }

    return `https://${this.options.bucket}.s3.${this.options.region}.amazonaws.com/${encodedKey}`;
  }

  async getUploadSignedUrl(key: string, contentType: string, expiresIn = 3600): Promise<{ uploadUrl: string, uploadExtraParams:  Record<string, string> }> {
    const command = new PutObjectCommand({
      Bucket: this.options.bucket,
      ContentType: contentType,
      ACL: (this.options.s3ACL || 'private') as  ObjectCannedACL,
      Key: key,
    });
    const uploadUrl = await getSignedUrl(this.getClient(), command, { expiresIn });
    return {
      uploadUrl,
      uploadExtraParams: {}
    };
  }

  async getDownloadUrl(key: string, expiresIn = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
    });
    if (this.options.s3ACL === "public-read") {
      return this.buildPublicObjectUrl(key);
    }
    // If the bucket is private, generate a presigned URL
    // that expires in the specified time
    // (default is 1 hour)
    return await getSignedUrl(this.getClient(), command, { expiresIn });
  }

  async markKeyForDeletation(key: string): Promise<void> {
    afLogger.error("Method \"markKeyForDeletation\" is deprecated, use markKeyForDeletion instead");
    await this.markKeyForDeletion(key);
  }

  async markKeyForNotDeletation(key: string): Promise<void> {
    afLogger.error("Method \"markKeyForNotDeletation\" is deprecated, use markKeyForNotDeletion instead");
    await this.markKeyForNotDeletion(key);
  }

  async markKeyForDeletion(key: string): Promise<void> {
    const cleanupMarkerKey = this.getCleanupDeletionMarkKey(key);
    await this.options.cleanupKeyValueAdapter.set(cleanupMarkerKey, key);
    await this.options.cleanupKeyValueAdapter.delete(this.getCleanupNotDeletionMarkKey(key));
  }

  async markKeyForNotDeletion(key: string): Promise<void> {
    const cleanupMarkerKey = this.getCleanupNotDeletionMarkKey(key);
    await this.options.cleanupKeyValueAdapter.set(cleanupMarkerKey, key);
  }

  async setupLifecycle(): Promise<void> {
    if (!this.options.accessKeyId || !this.options.secretAccessKey) {
      throw new Error("Missing S3 credentials in environment variables");
    }

    this.getClient();

    try {
      await this.getClient().send(new HeadBucketCommand({ Bucket: this.options.bucket }));
    } catch {
      throw new Error(`Bucket "${this.options.bucket}" does not exist`);
    }

    afLogger.debug("S3-compatible adapter initialized. Cleanup scheduler should use cleanupKeyValueAdapter records.");
  }

  objectCanBeAccesedPublicly(): Promise<boolean> {
    return Promise.resolve(this.options.s3ACL === "public-read");
  }

  async isInternalUrl(url: string): Promise<boolean> {
    try {
      const parsedUrl = new URL(url);
      const endpointHost = this.options.endpoint ? new URL(this.options.endpoint).hostname : null;
      const publicBaseHost = this.options.publicBaseUrl ? new URL(this.options.publicBaseUrl).hostname : null;
      const standardHost = `${this.options.bucket}.s3.${this.options.region}.amazonaws.com`;
      const legacyHost = `${this.options.bucket}.s3.amazonaws.com`;
      
      if (parsedUrl.hostname === standardHost || parsedUrl.hostname === legacyHost) {
        return true;
      }

      if (publicBaseHost && parsedUrl.hostname === publicBaseHost) {
        return true;
      }

      if (endpointHost) {
        if (parsedUrl.hostname === endpointHost && parsedUrl.pathname.startsWith(`/${this.options.bucket}/`)) {
          return true;
        }
        if (parsedUrl.hostname === `${this.options.bucket}.${endpointHost}`) {
          return true;
        }
      }

      if (parsedUrl.hostname.includes('amazonaws.com') && parsedUrl.pathname.startsWith(`/${this.options.bucket}/`)) {
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }
  /**
   * This method should return the key as a data URL (base64 encoded string).
   * @param key - The key of the file to be converted to a data URL
   * @returns A promise that resolves to a string containing the data URL
   */
  async getKeyAsDataURL(key: string): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
    });

    const body = await this.getClient().send(command);
    const stream = body.Body;

    if (!(stream instanceof Readable)) {
      throw new Error("Expected Body to be a Readable stream");
    }

    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const buffer = Buffer.concat(chunks);
    const base64String = buffer.toString('base64');
    const contentType = body.ContentType || 'application/octet-stream';

    return `data:${contentType};base64,${base64String}`;
  }
}
