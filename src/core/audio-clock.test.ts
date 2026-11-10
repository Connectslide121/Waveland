import { describe, expect, it, vi } from 'vitest';
import { AudioClock, type ClockContext } from './audio-clock';

/** A fake AudioContext whose time the test moves by hand. */
function fakeContext(latency = { outputLatency: 0, baseLatency: 0 }) {
  const sources: { start: ReturnType<typeof vi.fn>; onended: (() => void) | null }[] = [];
  const context = {
    currentTime: 100,
    state: 'running',
    destination: {},
    ...latency,
    resume: vi.fn(async () => {}),
    createBufferSource() {
      const source = {
        buffer: null,
        onended: null as (() => void) | null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      sources.push(source);
      return source;
    },
  };
  return { context: context as unknown as ClockContext & { currentTime: number }, sources };
}

const buffer = { duration: 60 } as AudioBuffer;

describe('AudioClock', () => {
  it('counts song time from the audio context, not from wall time', async () => {
    const { context, sources } = fakeContext();
    const clock = new AudioClock(buffer, { context, latencyMs: 0 });
    expect(clock.time).toBe(0);

    await clock.play();
    expect(sources[0]!.start).toHaveBeenCalledWith(0, 0);
    context.currentTime += 2.5;
    expect(clock.time).toBeCloseTo(2.5);
  });

  it('takes off the output latency and the player offset', async () => {
    const { context } = fakeContext({ outputLatency: 0.03, baseLatency: 0.01 });
    const clock = new AudioClock(buffer, { context, latencyMs: 100 });
    await clock.play(10);
    context.currentTime += 1;
    expect(clock.time).toBeCloseTo(10 + 1 - 0.04 - 0.1);
  });

  it('pauses where it is and plays on from there', async () => {
    const { context, sources } = fakeContext();
    const clock = new AudioClock(buffer, { context, latencyMs: 0 });
    await clock.play();
    context.currentTime += 4;
    clock.pause();
    expect(clock.playing).toBe(false);
    context.currentTime += 10;
    expect(clock.time).toBeCloseTo(4);

    await clock.play();
    expect(sources[1]!.start).toHaveBeenCalledWith(0, 4);
  });

  it('seeks, and stays within the song', async () => {
    const { context } = fakeContext();
    const clock = new AudioClock(buffer, { context, latencyMs: 0 });
    await clock.seek(30);
    expect(clock.time).toBe(30);
    await clock.seek(99);
    expect(clock.time).toBe(60);
    await clock.seek(-5);
    expect(clock.time).toBe(0);
  });

  it('tells when the song ends, but not when it was stopped', async () => {
    const { context, sources } = fakeContext();
    const clock = new AudioClock(buffer, { context, latencyMs: 0 });
    const ended = vi.fn();
    clock.onEnded = ended;

    await clock.play();
    clock.stop();
    expect(sources[0]!.onended).toBeNull();

    await clock.play();
    sources[1]!.onended!();
    expect(ended).toHaveBeenCalledOnce();
    expect(clock.playing).toBe(false);
    expect(clock.time).toBe(60);
  });

  it('wakes a suspended context before playing', async () => {
    const { context } = fakeContext();
    (context as { state: string }).state = 'suspended';
    const clock = new AudioClock(buffer, { context, latencyMs: 0 });
    await clock.play();
    expect(context.resume).toHaveBeenCalled();
  });
});
