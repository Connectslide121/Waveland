# Waveland

A collection of music games in the browser. You drop in any song and each game builds its level from the music: its beats, energy, sections and drops.

## Games

| Game | Status | Idea |
|---|---|---|
| Platformer | Planned, first | You run and jump yourself, but the world moves with the music: platforms rise and fall with the bass, bridges appear on snares, spikes retract on off-beats, drops become set pieces. |
| Tunnel | Idea for later | Race down a 3D tunnel that twists and climbs with the melody; obstacles and pickups land on the beat, steering between lanes. |

More music games can join later; each is a mode picked from the same menu.

## How it is built

- **TypeScript + Vite**, runs in the browser.
- **Core** (shared by every game): load a song, analyse it once (beats, tempo, energy over time, sections, drops), cache the result, and turn it into a level map that each game reads its own way.
- **Games** as separate modes: the platformer in **Phaser**, the tunnel later in **Three.js**.
- **Menus** (song picker, mode select, settings) in plain HTML and CSS over the game canvas.
- Everything is timed from the audio clock, never from frame time, so it stays in sync.

## Look

Neon geometric, drawn in code: glowing shapes on dark backgrounds, a simple character with squash and stretch, and everything pulsing and shifting colour with the music. No sprite art. Concept images are in `docs/concept/`.
