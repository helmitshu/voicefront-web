import { describe, it, expect } from 'vitest';
import { nextDispatchAction, parseOnCallRoster } from './dispatch';

describe('nextDispatchAction — escalation state machine', () => {
  const notifying = (currentIndex: number, rosterLength: number) =>
    ({ status: 'NOTIFYING' as const, currentIndex, rosterLength });

  it('accept ends the dispatch', () => {
    expect(nextDispatchAction(notifying(0, 3), 'accepted')).toEqual({ type: 'accept' });
  });

  it('a miss escalates to the next contact', () => {
    expect(nextDispatchAction(notifying(0, 3), 'no_answer')).toEqual({ type: 'call', index: 1 });
    expect(nextDispatchAction(notifying(1, 3), 'declined')).toEqual({ type: 'call', index: 2 });
    expect(nextDispatchAction(notifying(0, 3), 'timeout')).toEqual({ type: 'call', index: 1 });
    expect(nextDispatchAction(notifying(0, 3), 'failed')).toEqual({ type: 'call', index: 1 });
  });

  it('running off the end of the roster exhausts the dispatch', () => {
    expect(nextDispatchAction(notifying(2, 3), 'no_answer')).toEqual({ type: 'exhaust' });
  });

  it('ignores late events once already resolved (no reopening)', () => {
    expect(nextDispatchAction({ status: 'ACCEPTED', currentIndex: 1, rosterLength: 3 }, 'no_answer')).toEqual({ type: 'noop' });
    expect(nextDispatchAction({ status: 'EXHAUSTED', currentIndex: 2, rosterLength: 3 }, 'accepted')).toEqual({ type: 'noop' });
    expect(nextDispatchAction({ status: 'CANCELLED', currentIndex: 0, rosterLength: 3 }, 'timeout')).toEqual({ type: 'noop' });
  });
});

describe('parseOnCallRoster', () => {
  it('keeps valid contacts in order and defaults a missing name', () => {
    expect(
      parseOnCallRoster([
        { name: 'Mike', phone: '+15551112222' },
        { phone: '+15553334444' },
      ]),
    ).toEqual([
      { name: 'Mike', phone: '+15551112222' },
      { name: 'On-call tech', phone: '+15553334444' },
    ]);
  });

  it('drops entries with no phone and tolerates junk', () => {
    expect(parseOnCallRoster([{ name: 'No Phone' }, null, 'nope', 42])).toEqual([]);
    expect(parseOnCallRoster('not an array')).toEqual([]);
  });
});
