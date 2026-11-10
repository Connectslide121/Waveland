# Agent instructions: Waveland

This file is the single source of instructions for every coding agent. `CLAUDE.md` only imports it (`@AGENTS.md`).

## What this is

A personal, just-for-fun collection of music games in the browser (see `README.md`). Every game builds its level from a song the player drops in. It starts with a platformer; a 3D tunnel game comes later, and more may follow.

## Stack and structure

- TypeScript + Vite, no UI framework.
- `src/core/`: song loading, audio analysis (beats, tempo, energy, sections, drops), analysis cache, level-map generation shared by all games. How the analysis works, and why it is our own code rather than Essentia.js, is in `docs/core.md`; bump `ANALYSIS_VERSION` whenever it changes what it finds, so cached analyses are redone.
- `src/games/<game>/`: one folder per game. The platformer uses Phaser; the tunnel will use Three.js. A game only reads the core's level map, never analyses audio itself. The platformer's level generator, physics and validator are described in `docs/platformer.md`.
- `src/shell/`: menus (song picker, mode select, settings) in plain HTML/CSS over the canvas.
- `src/games/index.ts`: the game registry. A game plugs in with `{ id, name, blurb, icon, status }`; a `ready` game has `start(song, container, exit)` (an `AnalysedSong`: the song with its `SongAnalysis`), a `soon` game a plain-words `reason`. A running game owns its keys, Escape included (its own pause menu), and calls `exit` to go back to the menu.
- `src/theme/`: the palette, as CSS variables (`palette.css`) and TS constants for Phaser (`palette.ts`); a test keeps them identical. Use these, never hard-coded colours.
- Scripts: `npm run dev`, `build`, `typecheck`, `test`, `lint` (ESLint and Prettier; `npm run format` fixes formatting). TypeScript stays on 6.0 until typescript-eslint supports 7.
- Timing comes from the audio clock (`AudioContext.currentTime`), never from frame time.

## Rules

- Look: "Neon arcade" (chosen from three concepts in `docs/concept/concepts.html`; the full mock-up is `docs/concept/look.html`). Neon geometric, drawn in code: thick glow on a dark synth grid, pulse rings on the kick, colour reacting to the music. No sprite art unless asked.
- Palette with fixed meanings: night `#07060f` background, cyan `#2ef2ff` the player and safe paths, magenta `#ff2bd6` beat, score and drops, violet `#8a5cff` bass and world, orange `#ff8a2b` danger.
- Generated levels must always be completable: check every jump is reachable.
- Work directly on `main`; small commits with a message saying what and why. Never push unless asked.
