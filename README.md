# Waveland

A collection of music games in the browser. You drop in any song and each game builds its level from the music: its beats, energy, sections and drops.

## Games

| Game | Status | Idea |
|---|---|---|
| Platformer | Playable | An auto-runner locked to the song: you always run in time with the music, and jump, dash and slam through a world that moves with it. Equaliser columns rise and fall with the bass, bridges appear on snares, dash gates stand on the snares, spikes come out on off-beats, drops become set pieces. |
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
3. You run by yourself, always in time with the music: you can't speed up or stop. Stay alive until the song ends:
   - **jump** the pits and onto higher ground (hold for higher, tap for a short hop);
   - **dash** to hold your height for half a beat: smash through the orange dash gates (on the snares), or jump and then dash over a pit too wide for a jump;
   - **slam** to drop fast from the air, to get under an overhang in time; a slam landing on the beat is an accent, worth double;
   - violet equaliser columns carry you up and down with the bass; one that rises in front of you is a wall to jump;
   - dotted cyan bridges are only there for a beat or two after each snare;
   - orange spikes come out on every off-beat and go back in on the beat: cross on the beat or jump them;
   - coins sit on the hi-hats; on a drop a magenta staircase rises, with gems on every step.
   The first gate and the first overhang come in a calm spot, with a hint on screen saying which button to press.
4. Falling, running into a wall, touching spikes that are out, or hitting a gate without dashing sends you back to the start of the section, a bar before it, with your score as it was there.
5. Coins, gems and jumps, landings, dashes and slams on the beat build a combo (a perfect one is within 60 ms of the beat): every 8 in a row raises the multiplier, up to ×4. The results screen shows your score, accuracy, deaths and pickups.

Use **Song details** on the title screen to see what the analysis found and a preview of the level. If the music feels late against the picture (Bluetooth headphones), set the audio offset in **Settings**: nudge it, or tap along to calibrate.

## Controls

The defaults:

| | Keyboard | Mouse | Gamepad |
|---|---|---|---|
| Jump (hold for higher) | Space, W or ↑ | | A |
| Dash | Shift, J or X | Right click | X or RB |
| Slam | S or ↓ | Left click | B, or down on the d-pad or left stick |
| Pause | Esc | | Start |

Change them in **Settings → Controls**: click a slot, then press the key or button to use (Escape cancels, Backspace clears). Each action has three key slots and two mouse and gamepad slots; an input another action had moves over, and Settings says so. Esc and Start always pause. The pause menu shows the controls as they are bound now, and has Resume, Restart, Settings and Quit. Switching to another tab pauses too. There are no touch controls yet: play on a computer.

## How it is built

- **TypeScript + Vite**, runs in the browser.
- **Core** (shared by every game): load a song, analyse it once (beats, tempo, energy over time, sections, drops), cache the result, and turn it into a level map that each game reads its own way.
- **Games** as separate modes: the platformer in **Phaser**, the tunnel later in **Three.js**.
- **Menus** (song picker, mode select, settings) in plain HTML and CSS over the game canvas.
- Everything is timed from the audio clock, never from frame time, so it stays in sync.

## Look

Neon geometric, drawn in code: glowing shapes on dark backgrounds, a simple character with squash and stretch, and everything pulsing and shifting colour with the music. No sprite art. Concept images are in `docs/concept/`.
