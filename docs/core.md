# The song-analysis core

`src/core` turns a dropped song into a `SongAnalysis` (`src/core/types.ts`) that every game reads. It runs once per song, off the main thread, and is cached.

## Flow

1. **Load** (`load.ts`): read the file, hash it (SHA-256), and look the hash up in the cache.
2. **Decode** with the Web Audio API (`decodeAudioData` on the shared `AudioContext`). The decoded buffer is kept for playback.
3. **Analyse** in a Web Worker (`analysis/worker.ts`): the channels are mixed to mono and sent over; the worker reports progress and returns the analysis.
4. **Cache** (`cache.ts`): IndexedDB, keyed by the file's hash, stamped with `ANALYSIS_VERSION`. A record from another version is ignored, so bump the version whenever the analysis changes what it finds.
5. **Play** with `AudioClock` (`audio-clock.ts`). Games time everything from `clock.time`, never from frame time.

## What the analysis finds

All in `src/core/analysis`, pure TypeScript with no dependencies, run directly by the tests.

| Step | File | How |
|---|---|---|
| Spectrum | `spectrum.ts` | Hann-windowed FFT, ~46 ms frames every ~11.6 ms at any sample rate. Per frame: power and log-compressed spectral flux in three bands: low 30–150 Hz (kick, bass), mid 800–5000 Hz (snare crack), high 6–16 kHz (hats, cymbals). |
| Onsets | `onsets.ts` | Per band: flux peaks that are local maxima and rise above a moving average plus a share of the band's loud flux. Strength is the peak against the band's loud hits (0–1). |
| Tempo | `rhythm.ts` | Autocorrelation of a combined onset envelope (kick and snare weighted over hats), 60–200 BPM, leaning toward 120 BPM when octaves tie. When half the period still carries half the pulse (a backbeat outscoring the beat) the faster tempo wins. |
| Beats | `rhythm.ts` | Ellis's dynamic-programming beat tracker: beats sit on strong onsets and keep close to the period, so the grid holds through quiet passages. Leading and trailing beats in silence are trimmed. The final tempo is the slope of a line through the beats, so it is precise to well under 1 BPM. |
| Downbeats | `rhythm.ts` | 4/4 assumed. Of the four phases, the one where kicks land on 1 (and 3), snares on 2 and 4, and loudness jumps on 1. |
| Energy | `structure.ts` | Power per band and overall, at 50 samples a second, as 0–1 over the 40 dB below the song's loud parts. |
| Sections | `structure.ts` | Bar features (energy per band, onset density per band); a novelty curve compares the 4 bars before each bar line with the 4 after; its clear peaks, at least 4 bars apart, start new sections. |
| Drops | `structure.ts` | A section whose "drive" (energy plus bass energy) jumps by 0.15 or more over the one before, landing in the top part of the song's range. The drop is then moved to the bar line nearby (within a bar, or about 3.5 s) where the bass gets loudest against the bar before, since a build's last bar (a snare roll, a riser) often changes the music more than the drop itself. The section before it is a build (energy rising) or a breakdown; quiet first and last sections are intro and outro. |

## Why our own analysis and not Essentia.js

Essentia.js was the first choice for beat tracking, but we wrote the analysis ourselves:

- **Weight.** Essentia.js ships a ~2.5 MB WASM core plus glue for a game that needs a handful of algorithms. Ours is a few hundred lines and adds nothing to the bundle besides the worker.
- **Workers and tests.** Its WASM build is an Emscripten module that needs extra loading work inside a Vite module worker, and again under Vitest in Node. Pure TypeScript runs the same in the worker and in the tests, which check it against synthetic audio with known answers.
- **Licence.** Essentia.js is AGPL-3.0, a heavier obligation than this project needs.
- **Fit.** The games want what Essentia's beat trackers don't give directly anyway: onsets split into kick, snare and hat bands with strengths, energy per band, and drops. Those had to be written either way; the tempo and beat tracker on top of the same spectrum is a small step.

The trade-off: Essentia's multi-feature beat tracker is more robust on music with tempo changes, swing or weak percussion. Ours assumes a mostly steady tempo in 4/4, which fits the electronic and pop music the games are built around. If real songs show it falling short, Essentia.js can replace `rhythm.ts` behind the same `SongAnalysis` shape; bump `ANALYSIS_VERSION` when it does.

## Tests

`analysis/test-audio.ts` renders clicks, kicks, snares and hats at known times (seeded noise, so runs are repeatable). The tests check tempo within ±1 BPM at 90–150 BPM, beats within 25 ms, downbeats on bar starts, kicks, snares and hats each heard in their own band, and drops where a quiet passage turns loud.

## Timing and latency

`AudioClock.time` is the song time the player hears: the context's clock since playback started, minus the output latency the browser reports (`outputLatency + baseLatency`) and the player's own offset (`settings.ts`, `getLatencyMs`, ±500 ms, 0 until calibrated). A positive offset means the sound reaches the player later than the browser thinks, as with Bluetooth headphones.

## The level map

`level-map.ts` turns a `SongAnalysis` into the `LevelMap` every game reads (`types.ts`): pure data, the same for the same analysis.

- **Beat grid**: a straight line fitted through the tracked beats, extended to cover the whole song, so games can place things on any beat, even in silent intros. The bar phase is the one most of the analysis' downbeats agree on.
- **Levels per beat**: bass and overall energy averaged over each beat, spread to 0–1 over the song's own range.
- **Events**, sorted by time: kicks, snares and hats (onsets moved onto the eighth-note grid when within 0.15 beats of it), an off-beat halfway through every beat, drops moved onto the nearest bar line, and section starts with their kind.
- **Beat fit** (`beatFit`): `steady` when at least 80% of the tracked beats sit on the grid, `changing` when they drift off it (tempo changes, swing), `none` with fewer than 8 beats. Games keep to the one grid either way; the title screen says so under the song's name.
- **Seed**: a hash of the analysis, so games seed their randomness from the song (`random.ts` has the seeded generator).

The map is cheap to build and isn't cached; each game builds its own level from it.
