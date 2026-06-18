import type { KeyValueAdapter } from "adminforth";

export interface AdapterOptions {
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  s3ACL?: string,
  endpoint?: string;
  forcePathStyle?: boolean;
  publicBaseUrl?: string;
  cleanupKeyValueAdapter: KeyValueAdapter;
}