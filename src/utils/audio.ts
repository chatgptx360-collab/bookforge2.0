/**
 * Audio assembly happens in the browser.
 *
 * Gemini returns raw 16-bit PCM per passage, and a book is thousands of
 * passages. Stitching and encoding client-side keeps whole audiobooks off the
 * serverless function, where both the timeout and the response size would cap
 * how long a book could be.
 */

export const PCM_SAMPLE_RATE = 24000;

export function base64ToPcm(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // The model emits little-endian signed 16-bit samples.
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
}

export function concatPcm(parts: Int16Array[]): Int16Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Int16Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

/** Inserts a beat of silence, which stops chapters running into each other. */
export function silence(seconds: number, sampleRate = PCM_SAMPLE_RATE): Int16Array {
  return new Int16Array(Math.max(0, Math.round(seconds * sampleRate)));
}

export function pcmDurationSeconds(pcm: Int16Array, sampleRate = PCM_SAMPLE_RATE): number {
  return pcm.length / sampleRate;
}

/** Wraps PCM in a canonical 44-byte WAV header. */
export function encodeWav(pcm: Int16Array, sampleRate = PCM_SAMPLE_RATE, channels = 1): Blob {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = pcm.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  new Int16Array(buffer, 44).set(pcm);
  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Encodes to MP3 with lamejs. Loaded on demand — the encoder is large and most
 * sessions never ask for MP3.
 */
export async function encodeMp3(
  pcm: Int16Array,
  sampleRate = PCM_SAMPLE_RATE,
  kbps = 128,
  onProgress?: (fraction: number) => void,
): Promise<Blob> {
  const { Mp3Encoder } = await import('@breezystack/lamejs');
  const encoder = new Mp3Encoder(1, sampleRate, kbps);
  const blockSize = 1152; // one MP3 frame
  const chunks: Uint8Array[] = [];

  for (let offset = 0; offset < pcm.length; offset += blockSize) {
    const block = pcm.subarray(offset, Math.min(offset + blockSize, pcm.length));
    const encoded = encoder.encodeBuffer(block);
    if (encoded.length > 0) chunks.push(new Uint8Array(encoded));
    if (onProgress && offset % (blockSize * 400) === 0) onProgress(offset / pcm.length);
  }

  const flushed = encoder.flush();
  if (flushed.length > 0) chunks.push(new Uint8Array(flushed));
  onProgress?.(1);

  return new Blob(chunks as BlobPart[], { type: 'audio/mpeg' });
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = Math.floor(seconds % 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function safeFileName(text: string, fallback = 'audio'): string {
  const cleaned = text
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 70);
  return cleaned || fallback;
}
