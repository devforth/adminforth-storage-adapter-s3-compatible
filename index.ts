import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  ObjectCannedACL,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from 'stream';

import type { StorageAdapter } from "adminforth";
import { afLogger, convertPeriodToSeconds } from "adminforth";
import type { AdapterOptions } from "./types.js";

export default class AdminForthAdapterS3Storage implements StorageAdapter {
  protected s3: S3Client;
  protected options: AdapterOptions;
  protected lastCleanupCheckDate: Date | null = null;
  
  constructor(options: AdapterOptions) {
    this.options = options;
    this.options.cleanupCheckInterval = options.cleanupCheckInterval || '1h';
    this.options.cleanupGracePeriod = options.cleanupGracePeriod || '7d';
  }

  private parceCleanupKey(key: string): {
    timestamp: string;
    originalKey: string;
  } {
    const parts = key.split('||');
    if (parts.length !== 3) {
      throw new Error(`Invalid cleanup key format: ${key}`);
    }
    return {
      timestamp: parts[1],
      originalKey: parts[2],
    };
  }
  protected async runCleanup(): Promise<void> {
    afLogger.debug("Running cleanup for S3-compatible storage adapter...");
    //Getting cleanup records from the key-value adapter
    const cleanupRecords: Record<string, string>[] = await this.options.cleanupKeyValueAdapter.listByPrefix("clean=true||", 10);
    for (const cleanupRecord of cleanupRecords) {
      const cleanupKey = Object.keys(cleanupRecord)[0];
      if (!cleanupKey) {
        afLogger.error("Skipping cleanup record because it has no key");
        continue;
      }

      let timestamp: string;
      let originalKey: string;
      try {
        ({ timestamp, originalKey } = this.parceCleanupKey(cleanupKey));
      } catch (error) {
        afLogger.error(`Skipping cleanup key with invalid format: ${cleanupKey}. Error: ${error}`);
        continue;
      }
      
      afLogger.debug(`Processing cleanup key: ${cleanupKey}, original key: ${originalKey}, timestamp: ${timestamp}`);
      const cleanupTime = new Date(timestamp);
      const now = new Date();
      const gracePeriodSeconds = convertPeriodToSeconds(this.options.cleanupGracePeriod);
      //check if the cleanup record is older than the grace period
      if ((now.getTime() - cleanupTime.getTime()) / 1000 > gracePeriodSeconds) {
        afLogger.debug(`Key: ${originalKey} is expired. Checking if it can be deleted...`);
        const notDeletionKey = await this.options.cleanupKeyValueAdapter.get('clean=false||' + originalKey);
        afLogger.debug(`Not deletion key: ${notDeletionKey}`);
        //check if the key is marked for not deletion
        if (notDeletionKey) {
          // If the key is marked for not deletion, we skip the deletion process and remove the cleanup marker
          afLogger.debug(`Key: ${originalKey} is marked for not deletion. Skipping...`);
          await this.options.cleanupKeyValueAdapter.delete(cleanupKey);
        } else {
          // If the key is not marked for not deletion, we proceed to delete the object from S3 and remove the cleanup marker
          afLogger.debug(`Deleting key: ${originalKey} from S3...`);
          try {
            await this.getClient().send(
              new DeleteObjectCommand({
                Bucket: this.options.bucket,
                Key: originalKey,
              })
            );
            afLogger.debug(`Key: ${originalKey} deleted from S3. Removing cleanup marker...`);
            await this.options.cleanupKeyValueAdapter.delete(cleanupKey);
          } catch (error) {
            afLogger.error(`Error deleting key: ${originalKey} from S3: ${error}`);
          }
        }

      }
    }
  }

  protected checkAndRunCleanup(): void {
    const now = new Date();
    if (!this.lastCleanupCheckDate || (now.getTime() - this.lastCleanupCheckDate.getTime()) > convertPeriodToSeconds(this.options.cleanupCheckInterval) * 1000) {
      void this.runCleanup().catch((error) => {
        afLogger.error(`Error running cleanup: ${error}`);
      });
      this.lastCleanupCheckDate = now;
    }
  }


  protected getClient(): S3Client {
    if (this.options.cleanupKeyValueAdapter) {
      this.checkAndRunCleanup();
    }
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

  protected deleteKeyFromS3(key: string): Promise<void> {
    return this.getClient().send(
      new DeleteObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
      })
    ).then(() => {
      afLogger.debug(`Key: ${key} deleted from S3.`);
    }).catch((error) => {
      afLogger.error(`Error deleting key: ${key} from S3: ${error}`);
    });
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
    if (this.options.cleanupKeyValueAdapter) {
      this.markKeyForDeletion(key);
    }
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
    if (!this.options.cleanupKeyValueAdapter) {
      afLogger.warn(`cleanupKeyValueAdapter is not provided. Cannot mark key ${key} for deletion and delete it immidiately`);
      this.deleteKeyFromS3(key);
      return;
    }
    const cleanupMarkerKey = this.getCleanupDeletionMarkKey(key);
    await this.options.cleanupKeyValueAdapter.set(cleanupMarkerKey, key);
    await this.options.cleanupKeyValueAdapter.delete(this.getCleanupNotDeletionMarkKey(key));
  }

  async markKeyForNotDeletion(key: string): Promise<void> {
    if (!this.options.cleanupKeyValueAdapter) {
      afLogger.warn(`cleanupKeyValueAdapter is not provided. Cannot mark key ${key} for not deletion`);
      return;
    }
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

    afLogger.debug(`S3-compatible adapter initialized for bucket ${this.options.bucket}`);
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
