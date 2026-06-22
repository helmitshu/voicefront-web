import { Router } from 'express';
import { z } from 'zod';
import type { JobRequest } from '@prisma/client';
import { asyncHandler } from '../lib/http';
import { getAuth, requireAuth, requireRole } from '../middleware/auth';
import { createJobRequest, listJobRequests, updateJobRequest } from '../services/job.service';
import { E164_REGEX, normalizePhone } from '../lib/phone';

export const jobsRouter = Router();
jobsRouter.use(requireAuth);

/** Tenant-facing job shape. */
interface JobDto {
  id: string;
  customerName: string;
  customerPhone: string | null;
  serviceAddress: string | null;
  jobType: string | null;
  urgency: string;
  description: string | null;
  preferredCallback: string | null;
  status: string;
  source: string;
  notes: string | null;
  createdAt: string;
}

function toDto(job: JobRequest): JobDto {
  return {
    id: job.id,
    customerName: job.customerName,
    customerPhone: job.customerPhone,
    serviceAddress: job.serviceAddress,
    jobType: job.jobType,
    urgency: job.urgency,
    description: job.description,
    preferredCallback: job.preferredCallback,
    status: job.status,
    source: job.source,
    notes: job.notes,
    createdAt: job.createdAt.toISOString(),
  };
}

const ListQuerySchema = z.object({
  status: z.enum(['NEW', 'CONTACTED', 'SCHEDULED', 'CLOSED']).optional(),
});

jobsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const { status } = ListQuerySchema.parse(req.query);
    const jobs = await listJobRequests(auth.tenantId, { status });
    res.json({ jobs: jobs.map(toDto) });
  }),
);

const CreateSchema = z.object({
  customerName: z.string().trim().min(2).max(120),
  customerPhone: z
    .string()
    .trim()
    .transform(normalizePhone)
    .refine((v) => v === '' || E164_REGEX.test(v), 'Use E.164 format, e.g. +15551234567.')
    .optional(),
  serviceAddress: z.string().trim().max(500).optional(),
  jobType: z.string().trim().max(160).optional(),
  urgency: z.enum(['EMERGENCY', 'URGENT', 'ROUTINE']).default('ROUTINE'),
  description: z.string().trim().max(2000).optional(),
  preferredCallback: z.string().trim().max(200).optional(),
});

jobsRouter.post(
  '/',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const input = CreateSchema.parse(req.body);
    const job = await createJobRequest({
      tenantId: auth.tenantId,
      customerName: input.customerName,
      customerPhone: input.customerPhone || null,
      serviceAddress: input.serviceAddress || null,
      jobType: input.jobType || null,
      urgency: input.urgency,
      description: input.description || null,
      preferredCallback: input.preferredCallback || null,
      source: 'MANUAL',
    });
    res.status(201).json({ job: toDto(job) });
  }),
);

const PatchSchema = z
  .object({
    status: z.enum(['NEW', 'CONTACTED', 'SCHEDULED', 'CLOSED']),
    notes: z.string().trim().max(2000).nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update.' });

jobsRouter.patch(
  '/:id',
  requireRole('OWNER', 'MANAGER'),
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const patch = PatchSchema.parse(req.body);
    const job = await updateJobRequest(auth.tenantId, req.params.id, patch);
    res.json({ job: toDto(job) });
  }),
);
