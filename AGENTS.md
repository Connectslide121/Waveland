# Agent instructions: Waveland

This file is the single source of instructions for every coding agent. `CLAUDE.md` only imports it (`@AGENTS.md`).

## What this is

A personal, just-for-fun collection of music games in the browser (see `README.md`). Every game builds its level from a song the player drops in. It has a platformer and a 3D tunnel racer, and more may follow.

## Stack and structure

- TypeScript + Vite, no UI framework.
- `src/core/`: song loading, audio analysis (beats, tempo, energy, sections, drops, and the musical moments: held sounds, stops, accents, fills, syncopations, repeated bars), analysis cache, level-map generation shared by all games (with the song's mood beat by beat and each section's feel, which the platformer's terrain styles and look follow). How the analysis works, and why it is our own code rather than Essentia.js, is in `docs/core.md`; bump `ANALYSIS_VERSION` whenever it changes what it finds, so cached analyses are redone.
- `src/games/<game>/`: one folder per game. The platformer uses Phaser, the tunnel Three.js; each game loads its engine with a dynamic import when it starts, so the menu stays light. A game only reads the core's level map, never analyses audio itself. The platformer's level generator, physics and validator are described in `docs/platformer.md`, the tunnel's (track, physics, validator, scoring, scene, what its playtest tuned and its open points) in `docs/tunnel.md`. Both games' generators read their difficulty from a `DIFFICULTY` table in their `level/generate.ts`; when tuning one, play the synthetic test songs (`src/core/analysis/test-songs.ts`) and keep the numbers its doc gives per song in step.
- `src/games/shared/`: what every game shows over its canvas: the HUD (song, beats, score and combo, overdrive, progress, count-in, frame rate), the pause menu with the game's controls, the results screen, and the number formats. A game adds its own pieces on top (the platformer's boosters and hints). Also the scoring every game's run shares (`scoring.ts`: judging on the beat or eighth, the multiplier, overdrive, count-ins, ranks), the controls reader (`controls.ts`: `GameControls` for a game's actions from keys, mouse and gamepads, pause fixed) and the frame monitor (`perf.ts`: steps a game's quality levels down when frames stay slow, reported in Settings).
- `src/shell/`: menus (song picker, mode select, settings) in plain HTML/CSS over the canvas.
- `src/games/index.ts`: the game registry. A game plugs in with `{ id, name, blurb, icon, status, controls, difficulty }` (`controls`: the control actions it uses, listed per game in Settings; `difficulty`: what easy, normal and hard mean in it, under the title screen's picker); a `ready` game has `start(song, container, exit)` (an `AnalysedSong`: the song with its `SongAnalysis`), a `soon` game a plain-words `reason`. A running game owns its keys, Escape included (its own pause menu), and calls `exit` to go back to the menu.
- `src/theme/`: the palette, as CSS variables (`palette.css`) and TS constants for Phaser and Three.js (`palette.ts`); a test keeps them identical. Use these, never hard-coded colours.
- Scripts: `npm start` (dev server, opens the browser), `npm run dev` (dev server only), `build`, `typecheck`, `test`, `lint` (ESLint and Prettier; `npm run format` fixes formatting). TypeScript stays on 6.0 until typescript-eslint supports 7.
- Timing comes from the audio clock (`AudioContext.currentTime`), never from frame time.

## Rules

- Look: "Neon arcade" (chosen from three concepts in `docs/concept/concepts.html`; the full mock-up is `docs/concept/look.html`). Neon geometric, drawn in code: thick glow on a dark synth grid, pulse rings on the kick, colour reacting to the music. No sprite art unless asked.
- Palette with fixed meanings: night `#07060f` background, cyan `#2ef2ff` the player and safe paths, magenta `#ff2bd6` beat, score and drops, violet `#8a5cff` bass and world, orange `#ff8a2b` danger.
- Generated levels must always be completable: check every jump is reachable.
- Work directly on `main`; small commits with a message saying what and why. Never push unless asked.
