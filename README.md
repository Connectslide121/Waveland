# Waveland

A collection of music games in the browser. You drop in any song and each game builds its level from the music: its beats, energy, sections and drops.

## Games

| Game | Status | Idea |
|---|---|---|
| Platformer | Playable | You run and jump yourself, but the world moves with the music: equaliser columns rise and fall with the bass, bridges appear on snares, spikes come out on off-beats, drops become set pieces. |
| Tunnel | Idea for later | Race down a 3D tunnel that twists and climbs with the melody; obstacles and pickups land on the beat, steering between lanes. |

More music games can join later; each is a mode picked from the same menu.

## Run it

You need Node.js 22 or newer.

```sh
npm install
npm run dev
```

Then open the address Vite prints, normally <http://localhost:5173>. `npm run build` makes a static site in `dist/` (`npm run preview` serves it).

## Play

1. Pick **Platformer**, then drop a song on the drop zone (or click it to choose one): MP3, WAV or OGG, at least 15 seconds. The first time, the song is analysed for its beat, sections and drops, which takes a few seconds; after that it is remembered and loads at once.
2. Press **Play**. A one-bar count-in (4-3-2-1) starts you off.
3. The screen scrolls with the music. Stay on screen and alive until the song ends:
   - jump the pits, landing on the beat for points (a perfect landing is within 60 ms of it);
   - violet equaliser columns carry you up and down with the bass;
   - dotted cyan bridges are only there for a beat or two after each snare;
   - orange spikes come out on every off-beat and go back in on the beat: cross on the beat or jump them;
   - coins sit on the hi-hats; on a drop a magenta staircase rises, with gems on every step.
4. Falling, touching spikes that are out, or dropping off the left edge sends you back to the start of the section, a bar before it, with your score as it was there.
5. Coins, gems and on-beat landings build a combo: every 8 in a row raises the multiplier, up to ×4. The results screen shows your score, accuracy, deaths and pickups.

Use **Song details** on the title screen to see what the analysis found and a preview of the level. If the music feels late against the picture (Bluetooth headphones), set the audio offset in **Settings**: nudge it, or tap along to calibrate.

## Controls

| | Keyboard | Gamepad |
|---|---|---|
| Run | ← → or A D | Left stick or d-pad |
| Jump (hold for higher) | Space, ↑ or W | A (or B) |
| Pause | Esc | Start |

The pause menu has Resume, Restart, Settings and Quit. Switching to another tab pauses too. There are no touch controls yet: play on a computer.

## How it is built

- **TypeScript + Vite**, runs in the browser.
- **Core** (shared by every game): load a song, analyse it once (beats, tempo, energy over time, sections, drops), cache the result, and turn it into a level map that each game reads its own way.
- **Games** as separate modes: the platformer in **Phaser**, the tunnel later in **Three.js**.
- **Menus** (song picker, mode select, settings) in plain HTML and CSS over the game canvas.
- Everything is timed from the audio clock, never from frame time, so it stays in sync.

## Look

Neon geometric, drawn in code: glowing shapes on dark backgrounds, a simple character with squash and stretch, and everything pulsing and shifting colour with the music. No sprite art. Concept images are in `docs/concept/`.
