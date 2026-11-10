# The tunnel

`src/games/tunnel` is Waveland's second game: a race down a 3D tunnel built from the song, like Audiosurf or Thumper. It reads the same `LevelMap` from the core as the platformer and never analyses audio itself. Three.js draws it.

This file starts as the build plan (the design and the steps, `## Build steps`); each step updates the sections it changes, so it ends as the tunnel's reference, like `docs/platformer.md`.

## The design

A song-locked rail racer. The player never controls speed: their distance down the tunnel comes only from song time, `zAtTime(track, t)`, the integral of a speed per tempo segment (eased over a beat at each change, the same scheme as the platformer's scroll), so they reach each thing on its beat. Depth comes from steering and two actions:

- **Steer**: hop one lane left or right, `LANE_HOP_TIME` (about 0.12 s, eased) per hop; held, it hops again every `LANE_REPEAT` beats. Lanes are slots on the tunnel's lower arc: 3 on easy, 5 on normal and hard.
- **Jump**: a short hop over low walls (about half a beat in the air at 120 BPM), the tunnel's answer to the platformer's jump.
- **Overdrive**: the platformer's overdrive (4 bars ×2), on its own bindable button.

No dash or slam: the tunnel's depth is lanes and timing, not a move set. The controls are their own actions (`left`, `right`, plus the shared `jump` and `overdrive`), bound in Settings next to the platformer's.

**No deaths.** The music never stops for a crash: hitting an obstacle breaks the combo, costs points and a shield, flashes orange and shakes the camera (both off with reduced effects). Rank counts crashes instead of deaths. A race that stops and rewinds kills the flow these games are known for; the platformer keeps the checkpoint model.

## The track: what the music shapes

The track is pure data built from the `LevelMap` (in `level/`, run in a worker like the platformer's), the same for the same song and difficulty:

- **Path**: a centreline sampled per beat. The melody bends and climbs it: the melody contour (pitch height, from the core, see step 2) sets the climb, its movement sets the bend (rising lines turn one way, falling the other, held notes straighten). Bends are capped so the far end of the tunnel stays on screen.
- **Pulse**: the bass (`LevelMap.bass`, kicks) makes the tunnel's radius and ring glow pulse. Visual only, like the platformer's kick and snare pulses: never changes where lanes are.
- **Width and look per section feel** (`LevelMap.moods`): calm parts and breakdowns open into a wide, sparse tube with slow rings; grooves are steady; choruses tighten and brighten with ring walls on every beat; builds narrow and speed the ring rhythm up; the drop bursts open with a set piece (all lanes open, a pickup wave on the beat).

## The music-to-obstacle grammar

As in the platformer, every obstacle comes from a musical moment and the music sizes it; difficulty only leaves common ones out or makes them smaller, never moves them; randomness only breaks ties (seeded from `LevelMap.seed`).

- **Kicks**: blocks in one or two lanes, on the kick's time.
- **Snares**: a block on the opposite side to the last kick block, so a groove steers left-right with the beat.
- **Accents**: walls across all lanes but one gap lane (normal, hard) or two (easy); the strongest accents become low walls across every lane, to jump.
- **Held sounds**: a rail of pickups along one lane while they hold (a note), or a tunnel-wide ring of light (a chord), to ride.
- **Stops**: the tunnel goes dark and empty, and the band's return lands a wall the player must already be past.
- **Syncopations**: a block that slides one lane across, on the off-beat (hard).
- **Fills**: a slalom: one block per fill hit, alternating sides.
- **Repeated bars**: repeat their obstacle pattern (at the 4-bar phrase level for loops), so a chorus played twice reads the same twice.
- **Pickups** (magenta, scoring): on hi-hats and off-beats in the lanes left free, never in a lane the next obstacle forces the player out of too late to reach.

## Always completable

A validator (`level/validate.ts`) proves a clean run exists, as the platformer's does: it runs the same `stepRacer` the game uses (fixed `PHYSICS_DT` steps, song time, input `{ left, right, jump }`) and searches lane, hop and jump state through every obstacle row. Generator repairs widen a gap or leave an obstacle out until it passes; a test runs every synthetic test song (`src/core/analysis/test-songs.ts`) at every difficulty. `solveLevel` returns one way through as presses, for autoplay (dev: `waveland.autoplay()`). Boosters (shield, magnet), if any, are never needed.

## Scoring

`TunnelRun` (`run.ts`): pickups score, chains of pickups without a crash build the combo (×4), lane hops and jumps that land on the beat or eighth score perfect/good like the platformer's actions, overdrive doubles, clean sections (no crash) score a bonus, and the result ranks S/A/B/C on pickups taken, timing and crashes. The results screen and pause menu are the shared ones.

## Look

Neon arcade (`docs/concept/look.html`), drawn in code with Three.js: no textures or models. The tunnel is rings and lane lines of glowing lines on night `#07060f`, bloom on. Colours keep their meanings: cyan the player craft and the free lanes, violet the tunnel walls and bass pulse, magenta pickups, score and drops, orange obstacles. Colours from `src/theme/palette.ts`. A frame monitor (the platformer's `perf.ts`) lowers effects (bloom, ring count) to keep frames smooth, and says so in Settings.

## Build steps

Each step is a queue task with its own chat; each ends green (`npm run typecheck`, `test`, `lint`), committed on `main`, and updates this file.

1. **Shared game parts.** Move what both games need out of the platformer: the pause menu, results screen, modal and HUD pieces (`src/games/platformer/ui.ts`) into `src/games/shared/`; per-game control actions in Settings (`left`, `right` added, Settings lists each game's actions); per-game difficulty lines on the title screen (`GameDefinition` carries them). The platformer plays exactly as before.
2. **Melody contour in the core.** A per-frame pitch height (strongest partial in the melody range, log frequency, smoothed) put on the grid as `LevelMap.mood.melody` (per beat, 0–1 over the song's own range) and its movement. Bump `ANALYSIS_VERSION`, test on the synthetic songs, document in `docs/core.md`.
3. **The track.** `src/games/tunnel/level/`: path, lanes, speed (`zAtTime`), obstacles and pickups from the grammar above, `stepRacer` physics, the validator and repairs, `solveLevel`, run in a worker. Pure TypeScript, no Three.js; tests for the grammar, the validator and every test song at every difficulty.
4. **The run.** `TunnelRun`: input, collisions against the track, pickups, combo, overdrive, crashes, sections, results and rank, autoplay; tests.
5. **The game.** Three.js (`npm i three`), loaded only when the game starts; the session (audio clock, controls, pause, results, HUD), the scene (tunnel, lanes, craft, obstacles, pickups, pulses, bloom, camera following the path), frame monitor, reduced effects; the registry entry turns `ready`. Checked with screenshots on desktop and phone sizes.
6. **Playtest and tune.** Play the synthetic songs and a few real ones, tune speeds, lane hop timing, density per difficulty and the camera; update this file, `README.md` and `AGENTS.md`.
