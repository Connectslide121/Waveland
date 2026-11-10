import { describe, expect, it } from 'vitest';
import { DISPLAY_FRAMES, DisplayLead } from './display-lead';

/** Run `count` frames `ms` apart, returning the last lead. */
function frames(lead: DisplayLead, count: number, ms: number, from = 0): number {
  let last = 0;
  for (let i = 0; i < count; i++) last = lead.frame(from + i * ms);
  return last;
}

describe('DisplayLead', () => {
  it('leads by a frame and a half at 60 Hz before anything is measured', () => {
    expect(new DisplayLead().frame(0)).toBeCloseTo(DISPLAY_FRAMES / 60);
  });

  it('follows the display rate', () => {
    const lead = new DisplayLead();
    expect(frames(lead, 400, 1000 / 144)).toBeCloseTo(DISPLAY_FRAMES / 144, 4);
    expect(frames(lead, 400, 1000 / 30, 10_000)).toBeCloseTo(DISPLAY_FRAMES / 30, 3);
  });

  it('ignores hitches and hidden tabs', () => {
    const lead = new DisplayLead();
    frames(lead, 400, 1000 / 60);
    const before = lead.lead;
    lead.frame(400 * (1000 / 60) + 2000);
    expect(lead.lead).toBe(before);
  });
});
