/** A song the player dropped in or picked, before any analysis. */
export interface Song {
  file: File;
  /** The file name without its extension, for showing to the player. */
  title: string;
}

/** The audio formats the song picker takes, by extension and MIME type. */
export const SUPPORTED_AUDIO = {
  extensions: ['.mp3', '.wav', '.ogg'],
  mimeTypes: [
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/wave',
    'audio/x-wav',
    'audio/vnd.wave',
    'audio/ogg',
    'application/ogg',
  ],
} as const;

/** The `accept` value for a file input. */
export const AUDIO_ACCEPT = [...SUPPORTED_AUDIO.extensions, ...SUPPORTED_AUDIO.mimeTypes].join(',');

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

/** True when the file is an MP3, WAV or OGG (by extension, or by type when it has none). */
export function isSupportedAudio(file: Pick<File, 'name' | 'type'>): boolean {
  const ext = extensionOf(file.name);
  if (ext) return (SUPPORTED_AUDIO.extensions as readonly string[]).includes(ext);
  return (SUPPORTED_AUDIO.mimeTypes as readonly string[]).includes(file.type.toLowerCase());
}

/** A song from a picked file, or null when the file isn't a supported audio format. */
export function songFromFile(file: File): Song | null {
  if (!isSupportedAudio(file)) return null;
  const ext = extensionOf(file.name);
  const title = (ext ? file.name.slice(0, -ext.length) : file.name).trim() || file.name;
  return { file, title };
}
