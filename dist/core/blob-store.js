/**
 * Object storage for page images (Cloudflare R2, S3-compatible). Uses aws4fetch
 * (a tiny request signer over the native fetch) rather than the full AWS SDK.
 *
 * Configured via env — when unset, isConfigured() returns false and callers
 * transparently fall back to storing base64 in the database.
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 */
import { AwsClient } from 'aws4fetch';
function readConfig() {
    const accountId = process.env.R2_ACCOUNT_ID?.trim();
    const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
    const bucket = process.env.R2_BUCKET?.trim();
    if (!accountId || !accessKeyId || !secretAccessKey || !bucket)
        return null;
    return { accountId, accessKeyId, secretAccessKey, bucket };
}
/** Whether object storage is configured (R2_* env vars present). */
export function isConfigured() {
    return readConfig() !== null;
}
let _client = null;
function client(cfg) {
    if (!_client) {
        _client = new AwsClient({
            accessKeyId: cfg.accessKeyId,
            secretAccessKey: cfg.secretAccessKey,
            service: 's3',
            region: 'auto',
        });
    }
    return _client;
}
function objectUrl(cfg, key) {
    return `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}/${key}`;
}
export async function putObject(key, body, contentType) {
    const cfg = readConfig();
    if (!cfg)
        throw new Error('Object storage is not configured (set R2_* env vars).');
    const res = await client(cfg).fetch(objectUrl(cfg, key), {
        method: 'PUT',
        body: new Uint8Array(body),
        headers: { 'Content-Type': contentType },
    });
    if (!res.ok) {
        throw new Error(`R2 put failed (${res.status}): ${await res.text().catch(() => '')}`);
    }
}
export async function getObject(key) {
    const cfg = readConfig();
    if (!cfg)
        return null;
    const res = await client(cfg).fetch(objectUrl(cfg, key), { method: 'GET' });
    if (res.status === 404)
        return null;
    if (!res.ok)
        throw new Error(`R2 get failed (${res.status}) for ${key}`);
    const body = Buffer.from(await res.arrayBuffer());
    return { body, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
}
export async function deleteObject(key) {
    const cfg = readConfig();
    if (!cfg)
        return;
    await client(cfg).fetch(objectUrl(cfg, key), { method: 'DELETE' }).catch(() => { });
}
