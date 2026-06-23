import { describe, it, expect } from 'vitest';
import { resolveFeatureState } from './features.service';
import type { FeatureRequirement } from '../domain/features';

const ALL_MET: Record<FeatureRequirement, boolean> = { twilioSms: true, twilioVoice: true };
const NONE_MET: Record<FeatureRequirement, boolean> = { twilioSms: false, twilioVoice: false };

describe('resolveFeatureState — the three-layer control matrix', () => {
  it('is effective only when available AND entitled AND enabled', () => {
    const r = resolveFeatureState('ON_CALL_DISPATCH', 'CONSTRUCTION', { entitled: true, selfManage: true, enabled: true }, ALL_MET);
    expect(r.available).toBe(true);
    expect(r.effective).toBe(true);
  });

  it('operator entitlement is the master switch — off means not effective even if enabled', () => {
    const r = resolveFeatureState('ON_CALL_DISPATCH', 'CONSTRUCTION', { entitled: false, selfManage: true, enabled: true }, ALL_MET);
    expect(r.effective).toBe(false);
  });

  it('entitled but switched off is not effective', () => {
    const r = resolveFeatureState('ON_CALL_DISPATCH', 'CONSTRUCTION', { entitled: true, selfManage: true, enabled: false }, ALL_MET);
    expect(r.effective).toBe(false);
  });

  it('unmet platform requirement makes it unavailable (and never effective)', () => {
    const r = resolveFeatureState('ON_CALL_DISPATCH', 'CONSTRUCTION', { entitled: true, selfManage: true, enabled: true }, NONE_MET);
    expect(r.available).toBe(false);
    expect(r.unavailableReason).toMatch(/Twilio/i);
    expect(r.effective).toBe(false);
  });

  it('a trades-only feature is unavailable to a clinic', () => {
    const r = resolveFeatureState('ON_CALL_DISPATCH', 'CLINIC', { entitled: true, selfManage: true, enabled: true }, ALL_MET);
    expect(r.available).toBe(false);
    expect(r.unavailableReason).toMatch(/industry/i);
    expect(r.effective).toBe(false);
  });

  it('a feature with no requirements (service-area) is available with no Twilio', () => {
    const r = resolveFeatureState('SERVICE_AREA', 'CONSTRUCTION', { entitled: true, selfManage: false, enabled: true }, NONE_MET);
    expect(r.available).toBe(true);
    expect(r.effective).toBe(true);
  });

  it('defaults to all-off when the tenant has no stored row', () => {
    const r = resolveFeatureState('MISSED_CALL_TEXTBACK', 'CONSTRUCTION', undefined, ALL_MET);
    expect(r.entitled).toBe(false);
    expect(r.enabled).toBe(false);
    expect(r.effective).toBe(false);
  });
});
