export const MIB = 1024 * 1024;
export const PART_SIZE = 8 * MIB;
export const INPUT_TTL_MS = 24 * 60 * 60 * 1000;
export const UPLOAD_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_LIMITS = {
  maxBytes: 2 * 1024 * MIB,
  uploadsPerDay: 100,
  unfinished: 10,
  requestsPerSecond: 10,
  burst: 20,
} as const;
export const MEDIA = {
  'avatar-image': { maxBytes: 5 * MIB, types: ['image/jpeg', 'image/png'] },
  audio: {
    maxBytes: 500 * MIB,
    types: [
      'audio/mpeg',
      'audio/mp3',
      'audio/wav',
      'audio/x-wav',
      'audio/wave',
      'audio/vnd.wave',
      'audio/mp4',
      'audio/x-m4a',
      'audio/aac',
      'audio/ogg',
    ],
  },
  background: {
    maxBytes: 50 * MIB,
    types: ['image/png', 'image/jpeg', 'image/webp'],
  },
} as const;
export type MediaKind = keyof typeof MEDIA;
export type UploadStatus =
  | 'initializing'
  | 'uploading'
  | 'finalizing'
  | 'completed'
  | 'aborting'
  | 'aborted'
  | 'expired';
export interface CreateUpload {
  requestId: string;
  kind: MediaKind;
  contentType: string;
  size: number;
  /** SHA-256 of the local input; binds retries to the same file. */
  sha256: string;
}
export interface Upload {
  id: string;
  requestId: string;
  kind: MediaKind;
  contentType: string;
  size: number;
  sha256: string;
  status: UploadStatus;
  partSize: number;
  partCount: number;
  acceptedParts: number[];
  createdAt: string;
  uploadExpiresAt: string;
  completedAt?: string;
  expiresAt?: string;
  url?: string;
}
export interface ServiceError {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestId?: string;
  };
}
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isMediaKind(value: string): value is MediaKind {
  return Object.hasOwn(MEDIA, value);
}
export function validMedia(
  kind: MediaKind,
  contentType: string,
  size: number,
): boolean {
  return (
    Number.isSafeInteger(size) &&
    size > 0 &&
    size <= MEDIA[kind].maxBytes &&
    (MEDIA[kind].types as readonly string[]).includes(contentType)
  );
}
export function matchesMediaSignature(
  type: string,
  bytes: Uint8Array,
): boolean {
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, start + length));
  if (type === 'image/png')
    return (
      bytes.length >= 8 &&
      [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
    );
  if (type === 'image/jpeg')
    return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === 'image/webp')
    return ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP';
  if (
    ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'].includes(type)
  )
    return ['RIFF', 'RF64'].includes(ascii(0, 4)) && ascii(8, 4) === 'WAVE';
  if (type === 'audio/ogg') return ascii(0, 4) === 'OggS';
  if (['audio/mp4', 'audio/x-m4a'].includes(type))
    return ascii(4, 4) === 'ftyp';
  if (['audio/mpeg', 'audio/mp3'].includes(type))
    return (
      ascii(0, 3) === 'ID3' ||
      (bytes[0] === 255 && ((bytes[1] ?? 0) & 224) === 224)
    );
  if (type === 'audio/aac')
    return bytes[0] === 255 && ((bytes[1] ?? 0) & 246) === 240;
  return false;
}
export interface VideoSettings {
  width?: number;
  height?: number;
  fit?: 'crop' | 'contain';
  backgroundColor?: string;
  backgroundFit?: 'cover' | 'contain' | 'stretch';
  leadInSeconds?: number;
  leadOutSeconds?: number;
}
export const VIDEO_DEFAULTS = {
  width: 1024,
  height: 1024,
  fit: 'crop',
  backgroundColor: '#000000',
  backgroundFit: 'cover',
  leadInSeconds: 0,
  leadOutSeconds: 0,
} as const;
export type JobStatus =
  'queued' | 'processing' | 'succeeded' | 'failed' | 'expired';
export interface Job {
  id: string;
  status: JobStatus;
  avatarId?: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string;
  progress?: { stage: string };
  error?: { code: string; message: string; retryable: boolean };
}
export interface JobDetail {
  job: Job;
  videoUrl?: string;
  videoUrlExpiresAt?: string;
}
export interface CreatedJob {
  jobId: string;
  status: JobStatus;
  createdAt: string;
}
