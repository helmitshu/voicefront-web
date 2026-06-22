import type { AppointmentSource, JobRequest, JobStatus, JobUrgency } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http';
import { normalizePhone } from '../lib/phone';
import { sendEmergencyJobAlert } from './sms.service';

/**
 * Job/service-request intake. For trades, most calls don't map to a fixed
 * appointment slot — they're "send someone" or "I want a quote" — so they land
 * here as a structured, triageable record instead of evaporating into a call
 * transcript. The receptionist writes rows via the captureJobRequest tool; staff
 * also add and work them from the dashboard queue.
 */

export interface CreateJobInput {
  tenantId: string;
  customerName: string;
  customerPhone?: string | null;
  serviceAddress?: string | null;
  jobType?: string | null;
  urgency: JobUrgency;
  description?: string | null;
  preferredCallback?: string | null;
  source?: AppointmentSource;
  externalCallId?: string | null;
  /** Set only for the public landing-page demo, so demo jobs stay isolated and
   *  never fire a real owner alert. */
  demoSessionId?: string | null;
}

/**
 * Persist a job, then fire the owner emergency alert when warranted. The alert
 * is fire-and-forget so a Twilio hiccup never fails the call the agent is on.
 */
export async function createJobRequest(input: CreateJobInput): Promise<JobRequest> {
  const phone = input.customerPhone ? normalizePhone(input.customerPhone) || null : null;
  const job = await prisma.jobRequest.create({
    data: {
      tenantId: input.tenantId,
      customerName: input.customerName,
      customerPhone: phone,
      serviceAddress: input.serviceAddress ?? null,
      jobType: input.jobType ?? null,
      urgency: input.urgency,
      description: input.description ?? null,
      preferredCallback: input.preferredCallback ?? null,
      source: input.source ?? 'VOICE_AGENT',
      externalCallId: input.externalCallId ?? null,
      demoSessionId: input.demoSessionId ?? null,
    },
  });

  if (job.urgency === 'EMERGENCY' && !job.demoSessionId) {
    void sendEmergencyJobAlert(job.id).catch(() => {});
  }
  return job;
}

export interface ListJobsOptions {
  status?: JobStatus;
  limit?: number;
}

/**
 * The triage queue. Real (non-demo) jobs, newest first. Callers filter and
 * group by urgency/status client-side; the urgency enum doesn't sort usefully
 * in SQL (it's alphabetical), so ordering stays time-based here.
 */
export async function listJobRequests(tenantId: string, opts: ListJobsOptions = {}): Promise<JobRequest[]> {
  return prisma.jobRequest.findMany({
    where: {
      tenantId,
      demoSessionId: null,
      ...(opts.status ? { status: opts.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: opts.limit ?? 200,
  });
}

export interface UpdateJobPatch {
  status?: JobStatus;
  notes?: string | null;
}

/** Update a job's status or staff notes. Tenant-scoped so one workspace can
 *  never touch another's queue. */
export async function updateJobRequest(
  tenantId: string,
  id: string,
  patch: UpdateJobPatch,
): Promise<JobRequest> {
  const existing = await prisma.jobRequest.findFirst({ where: { id, tenantId } });
  if (!existing) throw new HttpError(404, 'Job not found.', 'JOB_NOT_FOUND');
  return prisma.jobRequest.update({
    where: { id },
    data: {
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    },
  });
}
