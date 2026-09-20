import { randomUUID } from "node:crypto";
import { FINAL_URL_TTL_SECONDS, PREVIEW_URL_TTL_SECONDS } from "../domain/deliverables.js";

/**
 * Safe file handling + storage abstraction (Session 10).
 *
 * Rules:
 * - Keys are server-minted UUIDs — never user-controlled paths (no traversal).
 * - Content types allowlisted, sizes capped, counts capped.
 * - Links must be https:// (no javascript:/data: smuggling).
 * - sha256, when supplied, must be 64 lowercase hex chars.
 * - A version must carry at least one of: files, links, preview text/ref,
 *   staging URL, or description — empty versions are rejected.
 * - Signed URLs always expire (previews ≤1h, finals ≤15min) and are issued
 *   ONLY after the route's access check (review vs released).
 */

export const MAX_FILES_PER_VERSION = 10;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_LINKS_PER_VERSION = 20;
export const MAX_DESCRIPTION_CHARS = 5000;
export const MAX_PREVIEW_TEXT_CHARS = 20000;

const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "application/zip",
  "application/x-zip-compressed",
  "application/json",
  "text/plain",
  "text/markdown",
  "text/html",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "video/mp4",
  "audio/mpeg",
  "application/octet-stream",
]);

export interface FileEntryInput {
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256?: string | undefined;
  /** review = preview-safe; final = only served after release. */
  readonly visibility: "review" | "final";
}

export interface ValidatedFileEntry extends FileEntryInput {
  readonly key: string;
}

export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactError";
  }
}

export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : "file";
}

export function mintObjectKey(deliverableId: string, versionNo: number): string {
  return `dv/${deliverableId}/v${versionNo}/${randomUUID()}`;
}

function isHex64(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

export function validateFileEntry(input: unknown): FileEntryInput {
  if (typeof input !== "object" || input === null) {
    throw new ArtifactError("Each file must be an object.");
  }
  const rec = input as Record<string, unknown>;
  const filename = typeof rec.filename === "string" ? rec.filename.trim() : "";
  if (filename.length < 1 || filename.length > 180) {
    throw new ArtifactError("Each file needs a filename (1–180 chars).");
  }
  const contentType = typeof rec.contentType === "string" ? rec.contentType.trim() : "";
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new ArtifactError(`Content type not allowed: ${contentType || "(missing)"}.`);
  }
  const sizeBytes = rec.sizeBytes;
  if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    throw new ArtifactError("Each file needs a positive integer sizeBytes.");
  }
  if (sizeBytes > MAX_FILE_BYTES) {
    throw new ArtifactError(`File too large: ${filename} exceeds 100 MB.`);
  }
  if (rec.sha256 !== undefined) {
    if (typeof rec.sha256 !== "string" || !isHex64(rec.sha256)) {
      throw new ArtifactError(`Invalid sha256 for file ${filename} (expect 64 hex chars).`);
    }
  }
  if (rec.visibility !== "review" && rec.visibility !== "final") {
    throw new ArtifactError(`File ${filename} needs visibility "review" or "final".`);
  }
  return {
    filename: sanitizeFileName(filename),
    contentType,
    sizeBytes,
    ...(typeof rec.sha256 === "string" ? { sha256: rec.sha256 } : {}),
    visibility: rec.visibility,
  };
}

export function validateLinkUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ArtifactError("Each link must be a non-empty URL string.");
  }
  const trimmed = value.trim();
  if (trimmed.length > 2000) throw new ArtifactError("Link URL too long (max 2000 chars).");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ArtifactError(`Invalid link URL: ${trimmed.slice(0, 80)}.`);
  }
  if (parsed.protocol !== "https:") {
    throw new ArtifactError("Links must use https:// (no http, data, or javascript URLs).");
  }
  return trimmed;
}

export function validateStagingUrl(value: unknown): string {
  return validateLinkUrl(value);
}

export interface VersionContentInput {
  readonly description?: string | undefined;
  readonly files?: readonly unknown[] | undefined;
  readonly links?: readonly unknown[] | undefined;
  readonly previewText?: string | undefined;
  readonly stagingUrl?: string | undefined;
}

export interface ValidatedVersionContent {
  readonly description?: string | undefined;
  readonly files: FileEntryInput[];
  readonly links: string[];
  readonly previewText?: string | undefined;
  readonly stagingUrl?: string | undefined;
}

/** Validate a version's mixed payload (files + links + previews + description). */
export function validateVersionContent(input: VersionContentInput): ValidatedVersionContent {
  const description =
    typeof input.description === "string" && input.description.trim().length > 0
      ? input.description.trim()
      : undefined;
  if (description !== undefined && description.length > MAX_DESCRIPTION_CHARS) {
    throw new ArtifactError("Description too long (max 5000 chars).");
  }
  const filesRaw = input.files ?? [];
  if (!Array.isArray(filesRaw)) throw new ArtifactError("files must be an array.");
  if (filesRaw.length > MAX_FILES_PER_VERSION) {
    throw new ArtifactError(`Too many files (max ${MAX_FILES_PER_VERSION} per version).`);
  }
  const files = filesRaw.map(validateFileEntry);
  const linksRaw = input.links ?? [];
  if (!Array.isArray(linksRaw)) throw new ArtifactError("links must be an array.");
  if (linksRaw.length > MAX_LINKS_PER_VERSION) {
    throw new ArtifactError(`Too many links (max ${MAX_LINKS_PER_VERSION} per version).`);
  }
  const links = linksRaw.map(validateLinkUrl);
  const previewText =
    typeof input.previewText === "string" && input.previewText.trim().length > 0
      ? input.previewText.trim()
      : undefined;
  if (previewText !== undefined && previewText.length > MAX_PREVIEW_TEXT_CHARS) {
    throw new ArtifactError("Preview text too long (max 20000 chars).");
  }
  const stagingUrl =
    typeof input.stagingUrl === "string" && input.stagingUrl.trim().length > 0
      ? validateStagingUrl(input.stagingUrl)
      : undefined;
  if (
    files.length === 0 &&
    links.length === 0 &&
    description === undefined &&
    previewText === undefined &&
    stagingUrl === undefined
  ) {
    throw new ArtifactError(
      "A version needs at least one of: files, links, preview text, staging URL, or description.",
    );
  }
  return {
    ...(description !== undefined ? { description } : {}),
    files,
    links,
    ...(previewText !== undefined ? { previewText } : {}),
    ...(stagingUrl !== undefined ? { stagingUrl } : {}),
  };
}

/** Clamp requested TTLs to the policy maximums (fail-safe, never extend). */
export function clampPreviewTtl(requestedSeconds: number): number {
  if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0) return PREVIEW_URL_TTL_SECONDS;
  return Math.min(Math.floor(requestedSeconds), PREVIEW_URL_TTL_SECONDS);
}

export function clampFinalTtl(requestedSeconds: number): number {
  if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0) return FINAL_URL_TTL_SECONDS;
  return Math.min(Math.floor(requestedSeconds), FINAL_URL_TTL_SECONDS);
}
