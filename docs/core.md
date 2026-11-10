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
| Spectrum | `spectrum.ts` | Hann-windowed FFT, ~46 ms frames (the nearest power of two) every 11.6 ms at any sample rate, 48 kHz included. Per frame: power and log-compressed spectral flux in three bands: low 30–150 Hz (kick, bass), mid 800–5000 Hz (snare crack), high 6–16 kHz (hats, cymbals). |
| Onsets | `onsets.ts` | Per band: flux peaks that are local maxima and rise above a moving average plus a share of the band's loud flux. Strength is the peak against the band's loud hits (0–1). |
| Tempo | `rhythm.ts` | Autocorrelation of a combined onset envelope (kick and snare weighted over hats), 60–200 BPM, leaning toward 120 BPM when octaves tie. When half the period still carries half the pulse (a backbeat outscoring the beat) the faster tempo wins. |
| Tempo map | `tempo.ts` | See [The tempo map](#the-tempo-map) below: the stretches of steady tempo and the beat each change lands on. A steady song is one segment, at exactly the tempo above. |
| Beats | `rhythm.ts` | Ellis's dynamic-programming beat tracker, run once over the song with each segment's period (the interval ending at a frame keeps to that frame's period, so beats join at a change without a skipped or doubled beat): beats sit on strong onsets and keep close to the period, so the grid holds through quiet passages. Leading and trailing beats in silence are trimmed. Each segment's tempo is the slope of a line through its beats, so it is precise to well under 1 BPM; the song's `tempo` is the one it spends most of its time at. |
| Downbeats | `rhythm.ts` | 4/4 assumed, found afresh in each tempo segment. Of the four phases, the one where kicks land on 1 (and 3), snares on 2 and 4, and loudness jumps on 1. |
| Energy | `structure.ts` | Power per band and overall, at 50 samples a second, as 0–1 over the 40 dB below the song's loud parts. |
| Sections | `structure.ts` | Bar features (energy per band, onset density per band); a novelty curve compares the 4 bars before each bar line with the 4 after; its clear peaks, at least 4 bars apart, start new sections. |
| Drops | `structure.ts` | A section whose "drive" (energy plus bass energy) jumps by 0.15 or more over the one before, landing in the top part of the song's range. The drop is then moved to the bar line nearby (within a bar, or about 3.5 s) where the bass gets loudest against the bar before, since a build's last bar (a snare roll, a riser) often changes the music more than the drop itself. The section before it is a build (energy rising) or a breakdown; quiet first and last sections are intro and outro. |

## Why our own analysis and not Essentia.js

Essentia.js was the first choice for beat tracking, but we wrote the analysis ourselves:

- **Weight.** Essentia.js ships a ~2.5 MB WASM core plus glue for a game that needs a handful of algorithms. Ours is a few hundred lines and adds nothing to the bundle besides the worker.
- **Workers and tests.** Its WASM build is an Emscripten module that needs extra loading work inside a Vite module worker, and again under Vitest in Node. Pure TypeScript runs the same in the worker and in the tests, which check it against synthetic audio with known answers.
- **Licence.** Essentia.js is AGPL-3.0, a heavier obligation than this project needs.
- **Fit.** The games want what Essentia's beat trackers don't give directly anyway: onsets split into kick, snare and hat bands with strengths, energy per band, and drops. Those had to be written either way; the tempo and beat tracker on top of the same spectrum is a small step.

The trade-off: Essentia's multi-feature beat tracker is more robust on music with swing or weak percussion. Ours follows tempo changes (a tempo map of steady stretches) but assumes 4/4 and a beat that is steady within each stretch: a gradual accelerando or rubato reads as one tempo with a loose beat. If real songs show it falling short, Essentia.js can replace `rhythm.ts` behind the same `SongAnalysis` shape; bump `ANALYSIS_VERSION` when it does.

## The tempo map

`tempo.ts` finds where a song's tempo changes (a rock song speeding up into its chorus, a bridge at another tempo, a switch into half time), so beats after a change stay on the music. `SongAnalysis.segments` lists them as `{ start, end, tempo, beatPeriod }`: the first starts at 0, the last ends at the song's end, each later one starts on the first beat played at its tempo.

1. **Local tempo.** The pulse's autocorrelation over 10 s windows every 1.5 s, scored for every tempo from 60 to 200 BPM in 48 steps an octave (about 1.5% apart), leaning toward 120 BPM. Where the faster octave still carries half the pulse it wins outright (the slower reading keeps 60% of its score), so a groove reads at its own tempo even when a half-time stretch follows it.
2. **Steady stretches.** A Viterbi path through the windows' tempos: staying costs nothing, drifting a step 0.15, changing tempo 2 (about three windows of clearly better fit). So a beat's wobble or a live band's drift never makes a change, octave-consistent readings win when they fit about as well, and a real half-time switch (the pulse really halving) reads as a change. Runs of the path become segments; neighbours within 2.5% are one, and stretches under 6 s join the neighbour nearest their tempo. One run is a steady song, and the whole analysis is then exactly the single-tempo one.
3. **The change, on the beat.** Around each change, both grids are walked from every candidate frame (back at the old period, on at the new one, each beat settling onto a hit within two frames), and the frame where the hits fit best wins. Every grid beat costs half a typical hit, so a slower grid that skips hits loses where the music is fast, and a faster grid with empty beats loses where it is slow. After the beats are tracked, a change between tempos a few percent apart (where both grids still land near the hits) moves to the tracked beat where the intervals switch from one period to the other, and the beats are tracked again.

The tests render songs with known changes (120 → 150 BPM, 140 → 100 → 140, clicks halving 140 → 70 → 140, a same-tempo half-time feel, a five-part rock song, the same at 48 kHz): every change is found on its beat, beats stay within 30 ms of the true ones on both sides, and steady songs stay one segment.

## Tests

`analysis/test-audio.ts` renders clicks, kicks, snares and hats at known times (seeded noise, so runs are repeatable). The tests check tempo within ±1 BPM at 90–150 BPM, beats within 25 ms, one tempo segment for steady songs, tempo changes found within a beat with beats within 30 ms on both sides (`tempoChangeSong`), downbeats on bar starts, kicks, snares and hats each heard in their own band, and drops where a quiet passage turns loud.

## Timing and latency

`AudioClock.time` is the song time the player hears: the context's clock since playback started, minus the output latency the browser reports (`outputLatency + baseLatency`) and the player's own offset (`settings.ts`, `getLatencyMs`, ±500 ms, 0 until calibrated). A positive offset means the sound reaches the player later than the browser thinks, as with Bluetooth headphones.

## The level map

`level-map.ts` turns a `SongAnalysis` into the `LevelMap` every game reads (`types.ts`): pure data, the same for the same analysis.

- **Beat grid** (`fitTempoGrid`): a straight line fitted through each tempo segment's tracked beats; the first is extended back to the song's start and the last on to its end, so games can place things on any beat, even in silent intros. Each later segment starts on its own grid's beat nearest the change, and the one before stops half a beat before it, so no beat is doubled. `LevelMap.segments` carries the segments with those starts. Each segment's bar phase is the one most of the analysis' downbeats in it agree on (or the bars going on from the segment before).
- **Reading the grid** (`tempo-map.ts`): `beatAt(map, t)` (fractional beat number), `timeOfBeat(map, b)`, `periodAt`, `tempoAt`, `segmentAt`, `barAt`, `beatInBar`, `beatIndexAt`, `beatsBefore` and `snapToGrid`. Every game uses these, never start + k × period: inside a segment they are exactly that arithmetic (so a steady song reads number for number as before), and across a change they go through the one interval between the segments. `steadyGrid` builds a one-tempo grid for tests.
- **Levels per beat**: bass and overall energy averaged over each beat, spread to 0–1 over the song's own range.
- **Events**, sorted by time: kicks, snares and hats (onsets moved onto the eighth-note grid when within 0.15 beats of it), an off-beat halfway through every beat, drops moved onto the nearest bar line, and section starts with their kind.
- **Beat fit** (`beatFit`): `none` with fewer than 8 beats; `loose` when fewer than 80% of the tracked beats sit on their segment's grid (swing, rubato, a gradual speed-up); otherwise `changing` with more than one tempo segment and `steady` with one. Games follow the tempo map either way; the title screen says so under the song's name ("Tempo changes, 120 → 150 BPM · the level follows it"), and the song details view shows the segments on its timeline (a TEMPO strip with the BPM of each, a dashed line at each change in the close-up).
- **Seed**: a hash of the analysis, so games seed their randomness from the song (`random.ts` has the seeded generator).

The map is cheap to build and isn't cached; each game builds its own level from it.
