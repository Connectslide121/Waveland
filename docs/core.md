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
| Beats | `rhythm.ts` | Ellis's dynamic-programming beat tracker, run once over the song with each segment's period (the interval ending at a frame keeps to that frame's period, so beats join at a change without a skipped or doubled beat): beats sit on strong onsets and keep close to the period, so the grid holds through quiet passages. Leading and trailing beats in silence are trimmed. Each segment's tempo is the slope of the grid its beats agree on (`grid-fit.ts`, below), so it is precise to well under 1 BPM; the song's `tempo` is the one it spends most of its time at. |
| Downbeats | `rhythm.ts` | 4/4 assumed, found afresh in each tempo segment. Of the four phases, the one where kicks land on 1 (and 3), snares on 2 and 4, and loudness jumps on 1. |
| Energy | `structure.ts` | Power per band and overall, at 50 samples a second, as 0–1 over the 40 dB below the song's loud parts. |
| Sections | `structure.ts` | Bar features (energy per band, onset density per band); a novelty curve compares the 4 bars before each bar line with the 4 after; its clear peaks, at least 4 bars apart, start new sections. |
| Drops | `structure.ts` | A section whose "drive" (energy plus bass energy) jumps by 0.15 or more over the one before, landing in the top part of the song's range. The drop is then moved to the bar line nearby (within a bar, or about 3.5 s) where the bass gets loudest against the bar before, since a build's last bar (a snare roll, a riser) often changes the music more than the drop itself. The section before it is a build (energy rising) or a breakdown; quiet first and last sections are intro and outro. |
| Chroma | `spectrum.ts` | Power per pitch class (C to B) from 110 Hz to 2 kHz, per frame: what notes and chords sound, for telling bars apart. |
| Melody | `spectrum.ts`, `melody.ts` | How high the melody is: see [The melody](#the-melody) below. |
| Musical moments | `features.ts` | Held sounds, stops, accents, fills, syncopations and repeated bars: see [The musical moments](#the-musical-moments) below. |

## The musical moments

`features.ts` finds the moments the games build their obstacles from (`SongAnalysis.features`, `MusicFeatures` in `types.ts`), from what the analysis already has: the hits per band (merged into one hit when bands hit within 35 ms), the loudness curves (0–1 over 40 dB, so 0.1 is 4 dB) and the beats. It runs on the hand-made analyses of the level tests too.

| Moment | How |
|---|---|
| Held sound (`Sustain`) | After a strong hit (0.55 in its band), the loudness stays within 8 dB of where it was just after the hit, with at most one kick or snare a beat, for 0.9 beats or more. It ends where the sound fades or the next strong kick or snare comes. What holds: a ringing cymbal when the highs outweigh the rest, a chord when three pitch classes or more sound (35% of the loudest), else a note. |
| Stop (`Stop`) | The loudness nearly silent (under 0.3, 28 dB below the song's loud parts) and 0.3 below the upper quartile of the music around it, for 0.9 beats or more with no hit in it, with the band playing just before and coming back after. It ends on the first hit as the band comes back. |
| Accent (`Accent`) | A hit in two bands or more whose bands are, between them, about 5 dB or more louder than that band's usual loud hits within 4 s (its upper quartile, so a bass or a guitar on every eighth doesn't make every kick over it an accent): a crash over the hats, a kick over the kicks. Loudness, not onset strength: strengths are capped at the band's loud hits, so a crash would read as just another hat. A beat apart at least. |
| Fill (`Fill`) | A run of kicks and snares (or toms) leading into a bar line: hits no more than 0.55 beats apart, the last within 0.75 beats of the line, at least 4 hits and 2.5 a beat, and 1.75 times as many as the same span of the bar before. |
| Syncopation (`Syncopation`) | A kick or snare of strength 0.5 or more at least 0.2 beats off the beat, outside a fill, that pushes against the groove: at least as loud (its bands' peak, within `SYNC_LOUD_SLACK`) as the drums on the beats either side, and in a spot of the bar (its sixteenth) the drums play in at most half the bars around it (`SYNC_GROOVE`, 4 bars either side). Eighth-note chugs and a busy kick are the groove: a punk song read without these rules had 955 syncopations in 123 bars, an obstacle on nearly every beat; with them 77. |
| Repeated bars (`BarInfo`) | Each bar's fingerprint: its mean chroma, its hits on a sixteenth grid per band (a hit counts a little in the slots either side, so a few ms off doesn't make a bar different) and its loudness. Two bars are alike by the cosine of their chroma and of their patterns, less what their loudness differs. A bar repeats the first bar of a group it is 0.95 alike or more with (`REPEAT_SIMILARITY`); a bar that repeats nothing repeats itself. |

The level map puts them on the grid (`gridFeatures`): hits snapped as the events are, held sounds' and stops' ends on the sixteenths, a fill's hits on the sixteenths ending on the grid's bar line, and one `BarInfo` per grid bar, repeating the first grid bar its analysis bar's group starts in.

They follow the tempo map but not swing or rubato any better than the beats do, and a held sound under drums that keep hitting hard reads as no held sound: the drums end it.

## The melody

The chroma says which notes sound but not how high; the tunnel's path climbs and bends with the melody, so the analysis also follows its pitch (`SongAnalysis.melody`, a `PitchCurve` at 50 samples a second in MIDI note numbers with fractions, 0 where there is none). It is cheap on purpose: no pitch tracker, just the strongest partial where one clearly stands out.

1. **Per frame** (`spectrum.ts`, in the same pass as the rest): the strongest bin from 200 Hz to 2 kHz (above most bass notes, up to a lead's top), placed between bins by a parabola through the log magnitudes around it and read as a note on the log-frequency (semitone) scale. It counts only when it is a peak of its own (not the skirt of a bass harmonic just below the range) and stands 10 dB above the median of the bins 3 to 8 either side (a partial does; a snare's band of noise doesn't, and a bass note among the neighbours doesn't count against it).
2. **Melody or not** (`melody.ts`): a frame has one when that peak holds at least 15% of the range's power (a chord wash or noise spreads it out) and the range is within 30 dB of its loud frames. A median over about 70 ms (4 of its 7 frames voiced) smooths it and drops single-frame jumps.

It hears a lead or a voice over a band as its notes; where a harmonic outsings the fundamental it reads an octave up, and where no lead plays a bass's harmonics or a chord's loudest note can stand in. That is fine for a contour: the games want up and down, not note names.

On the grid (`mood.ts`, `melodyCurves`), each beat's pitch is the median of its samples with a melody when at least 30% of the beat has one. Beats with none take the value between the heard beats around them (held before the first and after the last), so the curve never drops to 0 and back; the whole is smoothed like the other mood curves and spread to 0–1 over the 5th to 95th percentile of the heard beats (0.5 throughout when the melody spans less than a semitone or there is none). `mood.melodyMove` says, per beat, `rising` or `falling` when the smoothed pitch moves 0.4 semitones a beat or more, `held` otherwise, and `none` where no melody is heard, so a game can tell a real climb from a filled-in gap.

The song details view draws it under the energy (MELODY): the pitch heard as faint dots, the height per beat as a cyan line, dashed where no melody is heard.

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
2. **Steady stretches.** A Viterbi path through the windows' tempos: staying costs nothing, drifting a step 0.15, changing tempo 2 (about three windows of clearly better fit). So a beat's wobble or a live band's drift never makes a change, octave-consistent readings win when they fit about as well, and a real half-time switch (the pulse really halving) reads as a change. Runs of the path become segments; neighbours within 2.5% are one, and stretches under 6 s join the neighbour nearest their tempo (again once the changes are on the beat: a half-time feel read at half the tempo for its last few seconds joins its neighbour, an octave counting as the same tempo). One run is a steady song, and the whole analysis is then exactly the single-tempo one.
3. **The change, on the beat.** Around each change, both grids are walked from every candidate frame (back at the old period, on at the new one, each beat settling onto a hit within two frames), and the frame where the hits fit best wins. Every grid beat costs half a typical hit, so a slower grid that skips hits loses where the music is fast, and a faster grid with empty beats loses where it is slow. After the beats are tracked, a change between tempos a few percent apart (where both grids still land near the hits) moves to the tracked beat where the intervals switch from one period to the other, and the beats are tracked again.

The tests render songs with known changes (120 → 150 BPM, 140 → 100 → 140, clicks halving 140 → 70 → 140, a same-tempo half-time feel, a five-part rock song, the same at 48 kHz): every change is found on its beat, beats stay within 30 ms of the true ones on both sides, and steady songs stay one segment.

## Tests

`analysis/test-audio.ts` renders clicks, kicks, snares and hats at known times (seeded noise, so runs are repeatable). The tests check tempo within ±1 BPM at 90–150 BPM, beats within 25 ms, one tempo segment for steady songs, tempo changes found within a beat with beats within 30 ms on both sides (`tempoChangeSong`), downbeats on bar starts, kicks, snares and hats each heard in their own band, and drops where a quiet passage turns loud. `momentsSong` is a 120 BPM song with one of each moment at known times (crash accents, a held A minor chord, a full-band stop, a sixteenth-note snare fill, a four-bar riff of its own chords and drum patterns played twice): every moment is found on its time, nothing else is, and the riff's second time repeats its first bar for bar.

`melodySong` (`test-songs.ts`) is a 120 BPM groove with a lead that climbs the A minor scale two octaves a quarter note at a time, holds, falls back and holds low, with drum-only bars either side: at 22.05 and 48 kHz every note is heard within half a semitone, nothing is heard in the drum-only bars, and on the grid the climb rises beat by beat, the holds hold at the top and bottom of the range, the fall falls and the bars without a lead say `none`. The mood tests check the gap filling and that blips (a snare read as a pitch) don't count as a melody.

Whole songs in `analysis/test-songs.ts` are for playtesting and tuning the games end to end (`test-songs.test.ts`): `rockSong`, a stand-in for a fast rock song with tempo and mood changes (170 BPM with a pre-chorus fill, loud choruses with crashes, a full-band stop and a half-time breakdown; a quiet bridge and a build at 150; a last chorus at 180), and `electroSong`, a steady 128 BPM track with builds under a riser, drops and a drumless breakdown. Their tempo maps come out as built (170, 150, 180; one 128), the grid within 15 ms of every true beat and bar, the crashes as accents (not every downbeat over a bass and a guitar on the eighths), the drops and the quiet bridge as such. `wavFile` makes a WAV the browser can load.

## The song library

`src/core/library/` gives the player twenty songs without a file of their own. Nothing is shipped as audio: a song is a short description (`LibrarySong` in `songs.ts`: a style, a tempo, a key, a seed and a form of parts) and the composer (`compose.ts`) writes its samples from the synthetic sounds of `analysis/test-audio.ts` and `analysis/test-songs.ts` when it is picked. `composeInWorker` (`index.ts`, `worker.ts`) does that off the main thread, in a second or two, and hands back a WAV file named after the song; the title screen loads it like a dropped file (`TitleScreenOptions.library`), so it is hashed, analysed and cached the same way. The same description always gives the same samples, so the second time only the composing is paid for.

**Styles** (four songs each): electro (four on the floor, stabs, a bass off the beat, long builds), synthwave (slower, an octave bass, arpeggios and a long lead), rock (power chords, strummed choruses), drum and bass (a break with the kick on 1 and the "and" of 3, sixteenth hats) and chiptune (square waves, quick arpeggios). A seed picks each song's chords for the verse and the chorus (four-chord loops in its key), its kick patterns, the lead's rhythms and notes, whether a snare is pushed onto the "and" of 4, and whether the band stops.

**Forms** are three to five minutes whatever the tempo (`songSeconds`): 100 bars for the slow songs, 120 or 128 for the middle ones, 156 for the fast ones. Two rock songs slow down for the bridge and come back faster.

**Written to be read.** A part's bars depend only on the bar's place in its eight-bar phrase, so the song repeats itself and the analysis hears the repeats. Each part gives the games its moments: a verse has a kick pattern of its own, a snare on 2 and 4 and a fill into every eighth bar; a pre-chorus is a build (kicks on every beat, a snare roll speeding up, a riser, a silent last beat); a chorus has crashes opening its phrases, a busier kick, a lead whose eight-bar phrase ends on a held note, and from the second chorus on a full-band stop in its seventh bar; a breakdown is half time with held chords and a long lead; a bridge is quiet; the outro fades and ends on one hit ringing out. What the first drafts got wrong, for whoever changes the composer:

- A bass or a chord that never lets go reads as one held sound a bar: the rock and drum-and-bass songs came out with a held-note pit in most bars. Bass notes and strummed chords are short now, with air between them.
- A bass with strong overtones on every eighth reads as an accent on every eighth (102 dash gates in one song). Drum and bass uses the round bass.
- A dotted bass line under a drum-and-bass break pulls the tempo to two thirds. The bass plays straight eighths.

**The songs**, as the analysis reads them (44.1 kHz), and the obstacles a minute each gives on easy, normal and hard. The platformer's obstacles span several beats (a bridge is two presses, a held pit a jump and a dash), so it tops out near 30 a minute on any song; the tunnel's are one hit each.

| Song | Style | BPM | Length | Held · stops · accents · fills · off-beat | Platformer | Tunnel |
|---|---|---|---|---|---|---|
| Neon Overpass | Electro | 126 | 4:05 | 26 · 0 · 19 · 0 · 41 | 25 · 26 · 27 | 35 · 53 · 78 |
| Gridrunner | Electro | 128 | 4:02 | 43 · 0 · 20 · 3 · 15 | 27 · 28 · 28 | 39 · 55 · 76 |
| Voltage Bloom | Electro | 132 | 3:40 | 26 · 2 · 22 · 3 · 29 | 28 · 28 · 29 | 40 · 59 · 89 |
| Afterglow Circuit | Electro | 124 | 4:09 | 28 · 2 · 21 · 3 · 14 | 26 · 27 · 28 | 36 · 53 · 79 |
| Midnight Chrome | Synthwave | 100 | 4:01 | 14 · 0 · 22 · 4 · 19 | 18 · 23 · 23 | 35 · 53 · 73 |
| Sunset Vector | Synthwave | 108 | 4:28 | 32 · 2 · 19 · 3 · 38 | 22 · 23 · 24 | 34 · 47 · 70 |
| Laser Tide | Synthwave | 116 | 4:10 | 34 · 2 · 24 · 4 · 32 | 25 · 27 · 28 | 34 · 51 · 73 |
| Polaroid Skyline | Synthwave | 96 | 4:12 | 16 · 2 · 38 · 7 · 21 | 20 · 21 · 21 | 35 · 47 · 63 |
| Static Riot | Rock | 170 | 3:42 | 37 · 0 · 29 · 5 · 12 | 26 · 25 · 29 | 35 · 63 · 91 |
| Broken Antenna | Rock | 156 | 4:01 | 33 · 5 · 34 · 4 · 18 | 26 · 31 · 30 | 37 · 62 · 83 |
| Kerosene Hearts | Rock | 180 | 3:30 | 29 · 4 · 31 · 4 · 29 | 26 · 23 · 23 | 51 · 79 · 113 |
| Last Bus Out | Rock | 148 | 3:16 | 25 · 2 · 21 · 1 · 22 | 29 · 31 · 28 | 43 · 66 · 87 |
| Liquid Halogen | Drum and bass | 174 | 3:37 | 42 · 3 · 27 · 4 · 15 | 26 · 27 · 27 | 49 · 76 · 103 |
| Subway Ghosts | Drum and bass | 170 | 3:42 | 35 · 3 · 38 · 4 · 9 | 23 · 21 · 21 | 46 · 72 · 106 |
| Razorwire Sky | Drum and bass | 176 | 3:34 | 30 · 3 · 39 · 10 · 16 | 26 · 30 · 29 | 55 · 80 · 108 |
| Pulse Cascade | Drum and bass | 172 | 3:39 | 53 · 3 · 35 · 4 · 13 | 27 · 30 · 29 | 47 · 75 · 108 |
| Pixel Comet | Chiptune | 150 | 3:14 | 8 · 2 · 21 · 11 · 23 | 29 · 31 · 29 | 50 · 73 · 97 |
| Boss Rush | Chiptune | 160 | 3:56 | 16 · 3 · 31 · 14 · 24 | 27 · 31 · 24 | 54 · 77 · 102 |
| Coin Heaven | Chiptune | 140 | 3:27 | 9 · 2 · 31 · 7 · 12 | 29 · 30 · 30 | 37 · 59 · 84 |
| Game Over, Again | Chiptune | 168 | 3:44 | 21 · 3 · 30 · 14 · 33 | 30 · 31 · 28 | 58 · 78 · 106 |

Every song is found at exactly its tempo; the fast ones show their half-time breakdown as a segment at half the tempo, which the games fold to the same speed. `library.test.ts` composes one song at 22.05 kHz and checks its tempo, its moments and that both games build a level from it that can be finished; the numbers above come from running every song through the analysis and both generators, and are to be measured again when the composer changes.

## Timing and latency

`AudioClock.time` is the song time the player hears: the context's clock since playback started, minus the output latency the browser reports (`outputLatency + baseLatency`) and the player's own offset (`settings.ts`, `getLatencyMs`, ±500 ms, 0 until calibrated). A positive offset means the sound reaches the player later than the browser thinks, as with Bluetooth headphones.

A frame drawn at the heard time is only seen a frame or two later (the browser shows it at the next vsync, the display during the one after), so drawn that way everything trails the music by that much. A game draws for when the frame is seen instead: `AudioClock.time` plus `DisplayLead` (`display-lead.ts`), `DISPLAY_FRAMES` (1.5) times the display's own smoothed frame interval, about 25 ms at 60 Hz. Something judged from a press then acts that much after the song time it was pressed at, so the game judges it that much earlier (the platformer's `PlatformerRun.inputLead`).

## The level map

`level-map.ts` turns a `SongAnalysis` into the `LevelMap` every game reads (`types.ts`): pure data, the same for the same analysis.

- **Beat grid** (`fitTempoGrid`): each tempo segment's grid, the one its tracked beats agree on (`fitGrid` in `analysis/grid-fit.ts`): first the period near the segment's tempo whose grid the most beats line up with (their phases on it add up the most), then a straight line through the beats within a fifth of a beat of that grid, numbered by where they sit on it. So a stretch the tracker followed on the off-beats (a drumless breakdown over off-beat hats), or a skipped beat, can't tilt it: a line through every beat once drifted 230 ms off a 128 BPM track; the first is extended back to the song's start and the last on to its end, so games can place things on any beat, even in silent intros. Each later segment starts on its own grid's beat nearest the change, and the one before stops half a beat before it, so no beat is doubled. `LevelMap.segments` carries the segments with those starts. Each segment's bar phase is the one most of the analysis' downbeats in it agree on (or the bars going on from the segment before).
- **Reading the grid** (`tempo-map.ts`): `beatAt(map, t)` (fractional beat number), `timeOfBeat(map, b)`, `periodAt`, `tempoAt`, `segmentAt`, `barAt`, `beatInBar`, `beatIndexAt`, `beatsBefore` and `snapToGrid`. Every game uses these, never start + k × period: inside a segment they are exactly that arithmetic (so a steady song reads number for number as before), and across a change they go through the one interval between the segments. `steadyGrid` builds a one-tempo grid for tests.
- **Levels per beat**: bass and overall energy averaged over each beat, spread to 0–1 over the song's own range.
- **Events**, sorted by time: kicks, snares and hats (onsets moved onto the eighth-note grid when within 0.15 beats of it), an off-beat halfway through every beat, drops moved onto the nearest bar line, and section starts with their kind.
- **Musical moments** (`features`): the analysis' held sounds, stops, accents, fills, syncopations and repeated bars on the grid; see [The musical moments](#the-musical-moments).
- **Mood** (`mood.ts`): see [The mood](#the-mood) below: `mood`, five curves per grid beat (and the melody's movement), and `moods`, each section's mood and feel.
- **Beat fit** (`beatFit`): `none` with fewer than 8 beats; `loose` when fewer than 80% of the tracked beats sit on their segment's grid (swing, rubato, a gradual speed-up); otherwise `changing` with more than one tempo segment and `steady` with one. Games follow the tempo map either way; the title screen says so under the song's name ("Tempo changes, 120 → 150 BPM · the level follows it"), and the song details view shows the segments on its timeline (a TEMPO strip with the BPM of each, a dashed line at each change in the close-up).
- **Seed**: a hash of the analysis, so games seed their randomness from the song (`random.ts` has the seeded generator).

The map is cheap to build and isn't cached; each game builds its own level from it.

## The mood

`mood.ts` describes how each part of the song feels, so games can shape their whole world by it (the platformer's terrain styles and look, `docs/platformer.md`). It is built in the level map from what the analysis has (the melody curve needed `ANALYSIS_VERSION` 7; the rest changed nothing cached).

`LevelMap.mood` has five curves, one value per grid beat, each 0 to 1 and smoothed over about a bar (a triangular average two beats either side), so they follow the music's contour rather than every hit:

| Curve | From |
|---|---|
| `intensity` | The overall energy per beat, spread over the song's own range (the level map's `energy`). |
| `brightness` | The high band's share of the loudness (cymbals, a bright lead, distortion), spread over the song's range. |
| `density` | Hits per beat in all bands (strength 0.3 or more, hits within 35 ms counted once); 1 at four a beat (sixteenths) or more. |
| `heaviness` | The low band's share of the loudness (kick and bass), spread over the song's range. |
| `melody` | How high the melody is, spread over the song's range; beats with no melody filled in between the heard ones. With `melodyMove` per beat: `rising`, `falling`, `held` or `none`. See [The melody](#the-melody). |

`LevelMap.moods` has one `SectionMood` per section (same order as `sections`): the mean of the first four curves over the section's beats, and its `feel`:

| Feel | When |
|---|---|
| `build`, `drop`, `breakdown` | The structure's kind (`structure.ts`). |
| `calm` | An intro or outro unless loud (intensity over 0.55), or a main section at 0.3 or under. |
| `chorus` | A main section at 0.6 or more that is at 0.75 or more, or 0.08 louder than the song's middling (median) main section. |
| `build` | Also a main section whose last bar is 0.25 louder than its first, into a section 0.1 louder than it. |
| `groove` | Every other main section (a verse, a riff). |

`curveAt(curve, beat)` reads a curve between beats. The tests check a quiet intro into a loud, busy chorus (synthetic drums): intensity rises by more than half its range, smoothly over the change; the chorus is busier and brighter and the kicks-only intro heavier; the intro feels calm (or a lead-in) and the chorus loud; and the same analysis always gives the same mood.
