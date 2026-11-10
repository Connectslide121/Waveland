# The platformer's level

`src/games/platformer/level` builds the platformer's level in world space from the core's `LevelMap`, and proves it can be finished.

## The design

The camera scrolls with song time, at a speed from the tempo (`scrollSpeed` in `physics.ts`: the tempo folded into 80–160 BPM, 110 px per folded beat, so 147–293 px/s, always slower than the player runs). A player standing at the anchor (`ANCHOR_X` into the view) is exactly in time with the music: everything is placed at `xAtTime(t)`, so they reach each thing on its beat. The player runs and jumps freely inside the view, but no closer than `LOOKAHEAD` (280 px) to its right edge, so there is always about a second of level to see coming; falling behind its left edge, into a pit or onto spikes that are out is a death. Surviving until the song ends finishes the level.

| Element | From the music | In the level |
|---|---|---|
| Equaliser columns | Bass energy per beat | Columns, one per beat, whose height eases to the bass level on every beat; they carry the player |
| Bridges | Snares | Slabs over a pit, there for a beat or two after every snare near them |
| Spikes | Off-beats | Strips that are out from each off-beat to the next beat; cross on the beat or jump |
| Gaps | Beats | Pits to jump, taking off on a beat, landing higher or lower |
| Coins | Hi-hats | Where the anchored player is on the hat, over the ground or up in the jump over a pit; where there are no hats for a while (a quiet intro), on every other beat instead |
| Set piece | Drops | Two bars (four on fast songs): a staircase of bars to climb on the beat, a plateau, gems on every step |
| Calm stretches | Intros, breakdowns, outros | Plain wide ground, now and then a low step or an easy gap |

Fast songs (bars under 340 px) are laid out two bars per stretch, drops four, and on every other beat when beats are under 70 px: two such bars are too short for a staircase.

## Difficulty

`DIFFICULTY` in `generate.ts`: easy, normal and hard change how often a bar in a busy section gets an obstacle, gap widths (a share of the longest running jump), height changes, spike lengths, how long bridges stay, how far equalisers move, the staircase's step height and how many hats get a coin.

## Always completable

`physics.ts` has the player's constants (run speed, jump velocity, gravity, coyote time, box size) and `stepPlayer`, the one step function the game and the validator both run, at fixed `PHYSICS_DT` steps, against the level's moving parts at song time (`LevelWorld`).

The validator (`validate.ts`) is a search over the player's inputs: every three steps each candidate tries running right, standing and (in the air) running left, each with and without a jump; candidates in the same place are merged and the rest thinned evenly by position. It can only miss ways through, never invent one, so a level it passes can really be finished.

The generator builds a bar (or two) at a time and runs the search through it before going on, dropping candidates that reach past what is built, so every candidate kept is real in the finished level. A stretch nobody gets through, or that leaves nobody on the ground, is built again easier: narrower gaps and lower steps, then longer bridges and shorter spikes, then a ledge in each gap, and at last plain ground at the height the last stretch ended, which is always passable. `Chunk.repairs` counts the tries; the song details view shows them as "eased".

Deterministic: the generator's randomness is seeded by the song's map seed, the difficulty and the bar, so the same song at the same difficulty always gives the same level, and a repair never changes the bars after it.

## Playing it

`src/games/platformer/game.ts` starts a session: it builds the level in the worker (at normal difficulty, until there is a picker), decodes the song and runs Phaser.

- **Song time only.** Every frame the session reads `AudioClock.time` and `PlatformerRun.update` (`run.ts`) runs the fixed `PHYSICS_DT` steps of `stepPlayer` up to it, so the game moves exactly as the validator checked. The scene (`scene.ts`) draws the level as it is at that time: equaliser heights, bridges, spikes, the camera at `leftEdge(t)`, the squash, the effects. Nothing moves by frame time.
- **Feel.** Coyote time is in the physics. The jump buffer (`JUMP_BUFFER`) is in the run: a press counts for that long. Variable height is `release` in `stepPlayer`: letting go of jump while rising cuts the speed to `JUMP_CUT_VELOCITY`. The validator never lets go, so levels are still proven with full jumps.
- **Controls** (`controls.ts`): arrows or A/D, Space/Up/W to jump, Escape to pause; a gamepad's stick or d-pad, A to jump, Start to pause.
- **Deaths.** The run goes back to its checkpoint: the start of the stretch the current song section begins in (stretches start on a bar line on plain ground). The death effect plays for `DEATH_TIME` of song time, then the music rewinds to one bar before the checkpoint and the player waits through that bar as a 4-3-2-1 count-in. At the start the count-in is a bar of silence: `AudioClock.play` from a negative time.
- **Score.** Coins and gems, and jump landings within `PERFECT_WINDOW`/`GOOD_WINDOW` of a beat, add to a combo that raises the multiplier every `COMBO_STEP` up to ×4. A landing off the beat or a death breaks the combo, and a death puts the score back to what it was at the checkpoint. Accuracy on the results screen is the share of jump landings on the beat.
- **Look** (`scene.ts`, Neon arcade after `docs/concept/look.html`): bloom on the camera (Phaser's `AddEffectBloom`) over the synth grid rolling one row per beat, faint wave lines and the violet speaker sending out a ring on every kick; equalisers and ground with bright caps, dotted cyan bridges, orange spikes that rise a little just before they come out; the cube flips once per jump (from `run.jumpedAt`), squashes and stretches and leaves a light trail. Landings raise dust, pickups spark, deaths shatter the cube and shake the screen. Every effect is drawn from song time, so a pause freezes it and a rewind plays it again.
- **The drop's set piece**: through each drop chunk the sky flashes magenta and violet on every beat, two big waveforms ripple, particles burst from the player on every beat over the magenta staircase and DROP thumps at the top; then it calms down over two bars.
- **Effects intensity** (Settings): reduced turns off the flashes (the drop glows steadily instead) and the screen shake; it follows `prefers-reduced-motion` until the player picks. On a 1920×1080 canvas a drop frame takes about 5–10 ms of CPU and GPU, the bloom included.
- **Settings** (`src/shell/settings.ts`, from the title screen and the pause menu): music volume (a shared gain node, applied at once), effects intensity, and the audio latency offset, nudged in 5 ms steps or calibrated by tapping along to a 100 BPM metronome (the median lateness of the taps; uneven taps are turned down).
- **HUD and menus** (`ui.ts`) are HTML over the canvas: song and BPM, beat dots, score and combo, the count-in, progress with the drops marked; the pause menu (Esc: Resume, Restart, Settings, Quit) and the results screen (Retry, Back to menu). Switching away from the tab pauses. Resume holds the player where they stopped and rewinds the music `RESUME_BEATS` (two beats) for a short count-in, so play never starts again mid-jump without warning.

## Where to look

- Song details view, below the analysis: a side-on preview of the level at a picked difficulty, following the playhead (`src/shell/level-preview.ts`).
- `generateLevelInWorker(map, difficulty)` builds it off the main thread; a three-minute song takes about a second.
