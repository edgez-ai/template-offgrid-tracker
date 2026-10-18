import { config, exists, run } from "./appwrite.mjs";

export function installStorage() {
  const bucket = config.messageAttachmentBucket;
  const settings = [
    "--bucket-id", bucket.$id,
    "--name", bucket.name,
    "--permissions", ...bucket.permissions,
    "--file-security",
    "--enabled",
    "--maximum-file-size", String(bucket.maximumFileSize),
    "--allowed-file-extensions", ...bucket.allowedFileExtensions,
    "--compression", bucket.compression,
    "--encryption",
    "--antivirus",
    "--transformations",
  ];
  run(exists(["storage", "get-bucket", "--bucket-id", bucket.$id])
    ? ["storage", "update-bucket", ...settings]
    : ["storage", "create-bucket", ...settings]);
}
