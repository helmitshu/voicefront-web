import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../lib/http';
import { prisma } from '../lib/prisma';

vi.mock('../lib/prisma', () => ({
  prisma: {
    pooledNumber: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    agentSettings: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

const fetchVapiPhoneNumbers = vi.fn();
const getVapiPhoneNumber = vi.fn();
const configurePhoneNumberWebhook = vi.fn();
vi.mock('./vapi.service', () => ({
  fetchVapiPhoneNumbers: (...args: unknown[]) => fetchVapiPhoneNumbers(...args),
  getVapiPhoneNumber: (...args: unknown[]) => getVapiPhoneNumber(...args),
  configurePhoneNumberWebhook: (...args: unknown[]) => configurePhoneNumberWebhook(...args),
}));

import { addNumber } from './phone-pool.service';

const pooledFindUnique = vi.mocked(prisma.pooledNumber.findUnique);
const pooledCreate = vi.mocked(prisma.pooledNumber.create);

const NUMBER = '+15551234567';

beforeEach(() => {
  vi.clearAllMocks();
  pooledFindUnique.mockResolvedValue(null);
  pooledCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'pool_1',
    assignedTenantId: null,
    assignedAt: null,
    createdAt: new Date('2026-10-14T00:00:00Z'),
    ...data,
  }) as never);
  fetchVapiPhoneNumbers.mockResolvedValue([{ id: 'ph_1', number: NUMBER }]);
  getVapiPhoneNumber.mockResolvedValue(null);
  configurePhoneNumberWebhook.mockResolvedValue(undefined);
});

describe('addNumber', () => {
  it('pools a number found on the Vapi account by its E.164, webhook configured first', async () => {
    const created = await addNumber({ number: NUMBER });

    expect(configurePhoneNumberWebhook).toHaveBeenCalledTimes(1);
    expect(configurePhoneNumberWebhook).toHaveBeenCalledWith('ph_1');
    // Webhook configuration must happen before the pool row exists.
    expect(configurePhoneNumberWebhook.mock.invocationCallOrder[0]).toBeLessThan(
      pooledCreate.mock.invocationCallOrder[0],
    );
    expect(pooledCreate).toHaveBeenCalledWith({
      data: { number: NUMBER, country: 'US', vapiPhoneId: 'ph_1' },
    });
    expect(created.vapiPhoneId).toBe('ph_1');
  });

  it('accepts an explicit Vapi phone ID that matches the number', async () => {
    fetchVapiPhoneNumbers.mockResolvedValue([
      { id: 'ph_1', number: NUMBER },
      { id: 'ph_9', number: '+442071234567' },
    ]);
    const created = await addNumber({ number: '+442071234567', country: 'GB', vapiPhoneId: 'ph_9' });

    expect(configurePhoneNumberWebhook).toHaveBeenCalledWith('ph_9');
    expect(created.vapiPhoneId).toBe('ph_9');
    expect(created.country).toBe('GB');
  });

  it('falls back to a by-ID lookup when the list lags a just-created number', async () => {
    fetchVapiPhoneNumbers.mockResolvedValue([]);
    getVapiPhoneNumber.mockResolvedValue({ id: 'ph_new', number: NUMBER });

    const created = await addNumber({ number: NUMBER, vapiPhoneId: 'ph_new' });

    expect(getVapiPhoneNumber).toHaveBeenCalledWith('ph_new');
    expect(configurePhoneNumberWebhook).toHaveBeenCalledWith('ph_new');
    expect(created.vapiPhoneId).toBe('ph_new');
  });

  it('refuses a number that is not on the Vapi account', async () => {
    fetchVapiPhoneNumbers.mockResolvedValue([{ id: 'ph_2', number: '+15557654321' }]);

    await expect(addNumber({ number: NUMBER })).rejects.toMatchObject({
      status: 404,
      code: 'VAPI_NUMBER_NOT_FOUND',
    });
    expect(configurePhoneNumberWebhook).not.toHaveBeenCalled();
    expect(pooledCreate).not.toHaveBeenCalled();
  });

  it('refuses a Vapi phone ID that exists nowhere on the account', async () => {
    fetchVapiPhoneNumbers.mockResolvedValue([]);
    getVapiPhoneNumber.mockResolvedValue(null);

    await expect(addNumber({ number: NUMBER, vapiPhoneId: 'ph_ghost' })).rejects.toMatchObject({
      status: 404,
      code: 'VAPI_NUMBER_NOT_FOUND',
    });
    expect(configurePhoneNumberWebhook).not.toHaveBeenCalled();
    expect(pooledCreate).not.toHaveBeenCalled();
  });

  it('refuses when the given Vapi phone ID belongs to a different number', async () => {
    fetchVapiPhoneNumbers.mockResolvedValue([{ id: 'ph_1', number: '+15557654321' }]);

    await expect(addNumber({ number: NUMBER, vapiPhoneId: 'ph_1' })).rejects.toMatchObject({
      status: 400,
      code: 'VAPI_NUMBER_MISMATCH',
    });
    expect(configurePhoneNumberWebhook).not.toHaveBeenCalled();
    expect(pooledCreate).not.toHaveBeenCalled();
  });

  it('refuses the add when the webhook cannot be set, pooling nothing', async () => {
    configurePhoneNumberWebhook.mockRejectedValue(
      new HttpError(502, 'Could not point that number at the VoiceFront webhook.', 'VAPI_ERROR'),
    );

    await expect(addNumber({ number: NUMBER })).rejects.toMatchObject({ status: 502 });
    expect(pooledCreate).not.toHaveBeenCalled();
  });

  it('refuses a duplicate before ever asking Vapi', async () => {
    pooledFindUnique.mockResolvedValue({ id: 'pool_existing' } as never);

    await expect(addNumber({ number: NUMBER })).rejects.toMatchObject({
      status: 409,
      code: 'NUMBER_EXISTS',
    });
    expect(fetchVapiPhoneNumbers).not.toHaveBeenCalled();
    expect(pooledCreate).not.toHaveBeenCalled();
  });

  it('rejects a non-E.164 number outright', async () => {
    await expect(addNumber({ number: '555-1234' })).rejects.toMatchObject({
      status: 400,
      code: 'BAD_NUMBER',
    });
    expect(fetchVapiPhoneNumbers).not.toHaveBeenCalled();
    expect(pooledCreate).not.toHaveBeenCalled();
  });
});
