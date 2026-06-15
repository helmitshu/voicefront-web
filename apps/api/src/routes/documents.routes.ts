import { Router, raw } from 'express';
import type { Document } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError } from '../lib/http';
import { getAuth, requireAuth, requireRole } from '../middleware/auth';
import {
  deleteFileFromVapi,
  syncAssistantForTenant,
  uploadFileToVapi,
  type SyncResult,
} from '../services/vapi.service';

/**
 * Per-tenant knowledge-base documents. A customer uploads business files
 * (services, pricing, promotions, location, parking…) which we forward to
 * Vapi's file store and attach to their assistant as a knowledge base, so the
 * receptionist can answer questions from them. The file lives in Vapi; we keep
 * only metadata + the Vapi file id.
 */
export const documentsRouter = Router();
documentsRouter.use(requireAuth);

/** Hard cap on a single upload. Vapi indexes well under this for text docs. */
const MAX_BYTES = 20 * 1024 * 1024;

/** Common business document formats Vapi can index for a knowledge base. */
const ALLOWED_EXTENSIONS = new Set([
  'txt',
  'pdf',
  'docx',
  'doc',
  'csv',
  'md',
  'tsv',
  'yaml',
  'yml',
  'json',
  'xml',
  'log',
]);

interface DocumentDto {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  createdAt: string;
}

function toDto(doc: Document): DocumentDto {
  return {
    id: doc.id,
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    status: doc.status,
    createdAt: doc.createdAt.toISOString(),
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

documentsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const documents = await prisma.document.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ documents: documents.map(toDto) });
  }),
);

documentsRouter.post(
  '/',
  requireRole('OWNER', 'MANAGER'),
  // The body is the raw file bytes. We send a generic octet-stream content type
  // from the browser (filename + type travel in headers) so the global JSON
  // parser never touches it — important for .json knowledge files especially.
  raw({ type: () => true, limit: MAX_BYTES + 1024 * 1024 }),
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);

    const rawName = headerValue(req.headers['x-file-name']);
    if (!rawName) {
      throw new HttpError(400, 'Missing the file name.', 'MISSING_FILENAME');
    }
    // The browser sends an encoded name (HTTP headers are latin1-only).
    let fileName: string;
    try {
      fileName = decodeURIComponent(rawName).trim();
    } catch {
      fileName = rawName.trim();
    }
    if (fileName.length === 0) {
      throw new HttpError(400, 'The file needs a name.', 'MISSING_FILENAME');
    }

    const ext = extensionOf(fileName);
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new HttpError(
        400,
        `That file type isn't supported. Use a common document format like PDF, Word, TXT, CSV, or Markdown.`,
        'UNSUPPORTED_FILE_TYPE',
      );
    }

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new HttpError(400, 'The file appears to be empty.', 'EMPTY_FILE');
    }
    if (body.length > MAX_BYTES) {
      throw new HttpError(413, 'That file is too large. The limit is 20 MB.', 'FILE_TOO_LARGE');
    }

    const mimeType = headerValue(req.headers['x-file-type'])?.trim() || 'application/octet-stream';

    // Upload to Vapi first; only persist a row once the file actually exists
    // there, so our table never references a file Vapi doesn't have.
    const uploaded = await uploadFileToVapi(body, fileName, mimeType);
    const document = await prisma.document.create({
      data: {
        tenantId: auth.tenantId,
        vapiFileId: uploaded.id,
        fileName,
        mimeType,
        sizeBytes: body.length,
        status: uploaded.status,
      },
    });

    // Re-sync so the assistant's knowledge base includes the new file. Best-
    // effort: the document is saved regardless, with a note if the push lagged.
    const sync = await syncAssistantForTenant(auth.tenantId);
    res.status(201).json({ document: toDto(document), sync });
  }),
);

documentsRouter.delete(
  '/:id',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const document = await prisma.document.findFirst({
      where: { id: req.params.id, tenantId: auth.tenantId },
    });
    if (!document) {
      throw new HttpError(404, 'That document was not found.', 'DOCUMENT_NOT_FOUND');
    }

    // Remove from Vapi (best-effort), then drop our row, then re-sync so the
    // assistant no longer references the file.
    await deleteFileFromVapi(document.vapiFileId);
    await prisma.document.delete({ where: { id: document.id } });
    const sync: SyncResult = await syncAssistantForTenant(auth.tenantId);
    res.json({ ok: true, sync });
  }),
);
