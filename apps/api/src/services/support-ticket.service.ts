import type { SupportTicketCategory, SupportTicketStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';

/**
 * Support tickets: the rows a workspace files with the platform team,
 * normally through the in-app support agent (Adam) after the user confirms
 * a summary (see support-agent.service). This module owns the shared bits:
 * the human-facing category labels, the ticket reference the user is told,
 * and the platform team's read (the admin tickets endpoint).
 */

export const TICKET_CATEGORY_LABELS: Record<SupportTicketCategory, string> = {
  ISSUE: 'Support issue',
  BAD_CALL: 'Problem with a call',
  OTHER: 'Something else',
};

/** The reference a user is told when a ticket is filed, e.g. "VF-8KQ2XD". */
export function ticketReference(ticketId: string): string {
  return `VF-${ticketId.slice(-6).toUpperCase()}`;
}

export interface SupportTicketView {
  id: string;
  reference: string;
  category: SupportTicketCategory;
  categoryLabel: string;
  subject: string;
  details: string;
  status: SupportTicketStatus;
  createdAt: string;
  updatedAt: string;
  tenant: { id: string; companyName: string };
  createdBy: { id: string; email: string; fullName: string };
  call: { id: string; startedAt: string; callerNumber: string | null } | null;
}

/** The platform team's inbox read: newest first, optionally filtered. */
export async function listSupportTickets(params: {
  status?: SupportTicketStatus;
  tenantId?: string;
  limit?: number;
}): Promise<SupportTicketView[]> {
  const tickets = await prisma.supportTicket.findMany({
    where: {
      ...(params.status ? { status: params.status } : {}),
      ...(params.tenantId ? { tenantId: params.tenantId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(params.limit ?? 100, 1), 200),
    include: {
      tenant: { select: { id: true, companyName: true } },
      createdBy: { select: { id: true, email: true, fullName: true } },
      callLog: { select: { id: true, startedAt: true, callerNumber: true } },
    },
  });
  return tickets.map((t) => ({
    id: t.id,
    reference: ticketReference(t.id),
    category: t.category,
    categoryLabel: TICKET_CATEGORY_LABELS[t.category],
    subject: t.subject,
    details: t.details,
    status: t.status,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    tenant: t.tenant,
    createdBy: t.createdBy,
    call: t.callLog
      ? {
          id: t.callLog.id,
          startedAt: t.callLog.startedAt.toISOString(),
          callerNumber: t.callLog.callerNumber,
        }
      : null,
  }));
}
