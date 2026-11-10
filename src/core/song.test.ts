import { describe, expect, it } from 'vitest';
import { isSupportedAudio, songFromFile } from './song';

const file = (name: string, type = '') => new File(['x'], name, { type });

describe('isSupportedAudio', () => {
  it('takes MP3, WAV and OGG in any case', () => {
    expect(isSupportedAudio(file('a.mp3'))).toBe(true);
    expect(isSupportedAudio(file('a.WAV'))).toBe(true);
    expect(isSupportedAudio(file('a.Ogg'))).toBe(true);
  });

  it('refuses other files', () => {
    expect(isSupportedAudio(file('a.flac', 'audio/flac'))).toBe(false);
    expect(isSupportedAudio(file('cover.png', 'image/png'))).toBe(false);
  });

  it('goes by type when the name has no extension', () => {
    expect(isSupportedAudio(file('track', 'audio/mpeg'))).toBe(true);
    expect(isSupportedAudio(file('track', 'text/plain'))).toBe(false);
  });
});

describe('songFromFile', () => {
  it('titles the song after the file name without its extension', () => {
    expect(songFromFile(file('Midnight Drive.mp3'))?.title).toBe('Midnight Drive');
    expect(songFromFile(file('v1.2 final.ogg'))?.title).toBe('v1.2 final');
  });

  it('returns null for files it cannot play', () => {
    expect(songFromFile(file('notes.txt'))).toBeNull();
  });
});
