import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  buildImagePromptPart,
  imageMarker,
  isSupportedImage,
  stageImage,
} from '../src/images.js';

// The two paths need different things, and the most likely bug is treating them
// as the same: the API inlines bytes, the CLI needs a file it can read.

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccp-img-test-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A real 1x1 PNG, so the bytes are not a lie about their type. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

describe('isSupportedImage', () => {
  it('accepts the formats the CLI and API both handle', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      expect(isSupportedImage(mime), mime).toBe(true);
    }
  });

  it('rejects everything else, including audio and documents', () => {
    for (const mime of ['audio/mp3', 'application/pdf', 'text/plain', 'image/svg+xml']) {
      expect(isSupportedImage(mime), mime).toBe(false);
    }
  });
});

describe('buildImagePromptPart', () => {
  it('inlines a PNG as a data URL for the API path', () => {
    const url = buildImagePromptPart({ mimeType: 'image/png', data: PNG });
    expect(url).toMatch(/^data:image\/png;base64,/);
    // Round-trips: the base64 decodes back to the exact bytes.
    const b64 = url!.split(',')[1]!;
    expect(new Uint8Array(Buffer.from(b64, 'base64'))).toEqual(PNG);
  });

  it('returns null for an unsupported type rather than sending it', () => {
    expect(buildImagePromptPart({ mimeType: 'audio/mp3', data: PNG })).toBeNull();
  });

  it('returns null for an image over the size cap', () => {
    // A 20 MB image becomes a ~27 MB data URL, which is neither useful nor cheap.
    const huge = new Uint8Array(21 * 1024 * 1024);
    expect(buildImagePromptPart({ mimeType: 'image/png', data: huge })).toBeNull();
  });
});

describe('stageImage', () => {
  it('writes the bytes and returns a path the CLI can read', () => {
    const dir = tempDir();
    const path = stageImage({ mimeType: 'image/png', data: PNG }, dir);
    expect(path.startsWith(dir)).toBe(true);
    expect(path.endsWith('.png')).toBe(true);
    expect(new Uint8Array(readFileSync(path))).toEqual(PNG);
  });

  it('is content-addressed, so the same image is staged once', () => {
    const dir = tempDir();
    const a = stageImage({ mimeType: 'image/png', data: PNG }, dir);
    const b = stageImage({ mimeType: 'image/png', data: PNG }, dir);
    expect(a).toBe(b);
  });

  it('gives different images different paths', () => {
    const dir = tempDir();
    const other = new Uint8Array([...PNG, 0x00]);
    expect(stageImage({ mimeType: 'image/png', data: PNG }, dir)).not.toBe(
      stageImage({ mimeType: 'image/png', data: other }, dir),
    );
  });

  it('uses the extension that matches the mime type', () => {
    const dir = tempDir();
    expect(stageImage({ mimeType: 'image/jpeg', data: PNG }, dir).endsWith('.jpg')).toBe(true);
    expect(stageImage({ mimeType: 'image/webp', data: PNG }, dir).endsWith('.webp')).toBe(true);
    // An unknown type still gets a stable name rather than a bare collision.
    expect(stageImage({ mimeType: 'image/unknown', data: PNG }, dir).endsWith('.bin')).toBe(true);
  });
});

describe('imageMarker', () => {
  it('matches the shape the CLI recognises for an attached image', () => {
    expect(imageMarker(1, '/tmp/a.png')).toBe('[Image #1: /tmp/a.png]');
    expect(imageMarker(2, '/tmp/b.png')).toBe('[Image #2: /tmp/b.png]');
  });
});
