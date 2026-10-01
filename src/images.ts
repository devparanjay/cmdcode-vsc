/**
 * Image encoding for both transports.
 *
 * The two paths need different things, and conflating them is a bug waiting to
 * happen:
 *
 *  - **API path.** The Provider API accepts image content blocks natively, so
 *    the bytes are inlined as a `data:` URL. No temp file is involved.
 *  - **CLI path.** `cmd -p` reads images from a *path in the prompt*, so the
 *    bytes are written to a content-addressed temp file and the prompt names
 *    that file. The vendor documents that "only images from your most recent
 *    message are readable", so history never references one.
 *
 * Pure-ish: encoding is synchronous, staging is an explicit call the provider
 * makes so tests can point it at a temp dir.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

/** Formats the CLI and the API both handle. */
const SUPPORTED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** Guard: a 20 MB image becomes a ~27 MB data URL, which is neither useful nor cheap. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const EXTENSION: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/** Accept a data part, or null when the type is unsupported or the image is too large. */
export function buildImagePromptPart(part: {
  readonly mimeType: string;
  readonly data: Uint8Array;
}): string | null {
  if (!SUPPORTED_MIME.has(part.mimeType)) {
    return null;
  }
  if (part.data.byteLength > MAX_IMAGE_BYTES) {
    return null;
  }
  return `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}`;
}

export function isSupportedImage(mimeType: string): boolean {
  return SUPPORTED_MIME.has(mimeType);
}

/**
 * Directory for staged images. Content-addressed names mean re-attaching the
 * same screenshot costs nothing, and the files are disposable.
 */
export function stagingDir(): string {
  const dir = join(tmpdir(), 'command-code-provider-images');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write an image to a stable path derived from its bytes, and return it.
 *
 * The same bytes always produce the same filename, so a follow-up turn that
 * re-sends the same image reuses the file rather than filling the temp dir.
 */
export function stageImage(part: {
  readonly mimeType: string;
  readonly data: Uint8Array;
}, dir: string = stagingDir()): string {
  const digest = createHash('sha256').update(part.data).digest('hex').slice(0, 32);
  // Honour the real extension when the mime type is one we know, otherwise let
  // the caller pass a filename whose suffix we can trust.
  const ext = EXTENSION[part.mimeType] ?? '.bin';
  const path = join(dir, `${digest}${ext}`);
  writeFileSync(path, part.data);
  return path;
}

/** The marker the CLI recognises for an attached image. */
export function imageMarker(index: number, path: string): string {
  return `[Image #${index}: ${path}]`;
}
