# Waveland

A collection of music games in the browser. You drop in any song and each game builds its level from the music: its beats, energy, sections and drops.

## Games

| Game | Status | Idea |
|---|---|---|
| Platformer | Playable | An auto-runner locked to the song: you always run in time with the music, and jump, dash and slam through a world that moves with it. Equaliser columns rise and fall with the bass, bridges appear on snares, dash gates stand on the accents, slam plates break on heavy kicks and at the end of fills, spikes come out on off-beats, drops become set pieces. |
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
2. Pick a difficulty: **Easy** (relaxed: fewer, smaller obstacles on the strongest hits), **Normal**, or **Hard** (nearly every hit, with dash and slam combos). The pick is remembered. Then press **Play**. A one-bar count-in (4-3-2-1) starts you off.
3. You run by yourself, always in time with the music: you can't speed up or stop. Stay alive until the song ends:
   - **jump** the pits and onto higher ground (hold for higher, tap for a short hop);
   - **dash** to hold your height for half a beat: smash through the orange dash gates (on the accents: a crash, a big hit), or jump and then dash over a pit too wide for a jump;
   - **slam** to drop fast from the air: it breaks through the cracked slam plates (on a heavy kick, at the end of a fill, and on hard at the start of a chorus's phrases), the only way under the low ceiling just past them;
   - violet equaliser columns carry you up and down with the bass; one that rises in front of you is a wall to jump;
   - dotted cyan bridges are only there for a beat or two after each snare;
   - orange spikes come out on every off-beat and go back in on the beat: cross on the beat or jump them;
   - coins sit on the hi-hats; on a drop a magenta staircase rises, with gems on every step;
   - boosters float at the top of a full jump, some over pits: a **shield** (a cyan ring: survive one hit or fall, and bounce back onto safe ground), a **magnet** (pulls coins in for 4 bars) and an **extra dash** (a second dash in the air until you land). You never need one to finish.
   The first gate and the first slam plate come with a hint on screen saying which button to press.
4. Falling, running into a wall, touching spikes that are out, or hitting a gate without dashing sends you back to the start of the section, a bar before it, with your score, combo, overdrive meter and boosters as they were there.
5. Scoring:
   - every jump takeoff, dash and slam landing is judged against the nearest beat or eighth: **Perfect** (within 50 ms), **Good** (within 100 ms) or **Miss**, shown as a word at the cube. A jump's landing scores when it is on the grid, and is never a miss. On fast songs the windows get tighter. A dash on a snare, or a slam landing on a kick or a downbeat, is an **accent**, worth double;
   - judged actions and pickups build a **combo**; a miss or a hit breaks it. Every 8 in a row raises the multiplier, up to ×4 (the meter under the score);
   - perfects and gems fill the **overdrive** meter (bottom left). When it's full, press overdrive (E): for 4 bars your score is doubled on top of the combo, and the cube burns magenta. Starting it on a downbeat earns a bonus;
   - 10 perfects in a row burst for a bonus, and a section without a hit earns a **clean section** bonus;
   - the results screen shows your score and rank with the perfect, good and miss counts, timing, best combo, overdrives, clean sections, pickups and shield saves. Rank S needs 85% timing and no deaths, A 70% and at most 2 deaths, B 50%; C is finishing. Timing counts a good as half a perfect.

Use **Song details** on the title screen to see what the analysis found and a preview of the level. If the music feels late against the picture (Bluetooth headphones), set the audio offset in **Settings**: nudge it, or tap along to calibrate.

## Controls

The defaults:

| | Keyboard | Mouse | Gamepad |
|---|---|---|---|
| Jump (hold for higher) | Space, W or ↑ | | A |
| Dash | Shift, J or X | Right click | X or RB |
| Slam | S or ↓ | Left click | B, or down on the d-pad or left stick |
| Overdrive | E or L | | Y |
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
