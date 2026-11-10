# The platformer's level

`src/games/platformer/level` builds the platformer's level in world space from the core's `LevelMap`, and proves it can be finished.

## The design

The camera scrolls with song time, at a speed from the tempo (`scrollSpeed` in `physics.ts`: the tempo folded into 80–160 BPM, 110 px per folded beat, so 147–293 px/s, always slower than the player runs). A player standing at the anchor (`ANCHOR_X` into the view) is exactly in time with the music: everything is placed at `xAtTime(t)`, so they reach each thing on its beat. The player runs and jumps freely inside the view; falling behind its left edge, into a pit or onto spikes that are out is a death. Surviving until the song ends finishes the level.

| Element | From the music | In the level |
|---|---|---|
| Equaliser columns | Bass energy per beat | Columns, one per beat, whose height eases to the bass level on every beat; they carry the player |
| Bridges | Snares | Slabs over a pit, there for a beat or two after every snare near them |
| Spikes | Off-beats | Strips that are out from each off-beat to the next beat; cross on the beat or jump |
| Gaps | Beats | Pits to jump, taking off on a beat, landing higher or lower |
| Coins | Hi-hats | Where the anchored player is on the hat, over the ground or up in the jump over a pit |
| Set piece | Drops | Two bars: a staircase of bars to climb on the beat, a plateau, gems on every step |
| Calm stretches | Intros, breakdowns, outros | Plain wide ground, now and then a low step or an easy gap |

Fast songs (bars under 340 px) are laid out two bars per stretch, and on every other beat when beats are under 70 px.

## Difficulty

`DIFFICULTY` in `generate.ts`: easy, normal and hard change how often a bar in a busy section gets an obstacle, gap widths (a share of the longest running jump), height changes, spike lengths, how long bridges stay, how far equalisers move, the staircase's step height and how many hats get a coin.

## Always completable

`physics.ts` has the player's constants (run speed, jump velocity, gravity, coyote time, box size) and `stepPlayer`, the one step function the game and the validator both run, at fixed `PHYSICS_DT` steps, against the level's moving parts at song time (`LevelWorld`).

The validator (`validate.ts`) is a search over the player's inputs: every three steps each candidate tries running right, standing and (in the air) running left, each with and without a jump; candidates in the same place are merged and the rest thinned evenly by position. It can only miss ways through, never invent one, so a level it passes can really be finished.

The generator builds a bar (or two) at a time and runs the search through it before going on, dropping candidates that reach past what is built, so every candidate kept is real in the finished level. A stretch nobody gets through, or that leaves nobody on the ground, is built again easier: narrower gaps and lower steps, then longer bridges and shorter spikes, then a ledge in each gap, and at last plain ground at the height the last stretch ended, which is always passable. `Chunk.repairs` counts the tries; the song details view shows them as "eased".

Deterministic: the generator's randomness is seeded by the song's map seed, the difficulty and the bar, so the same song at the same difficulty always gives the same level, and a repair never changes the bars after it.

## Where to look

- Song details view, below the analysis: a side-on preview of the level at a picked difficulty, following the playhead (`src/shell/level-preview.ts`).
- `generateLevelInWorker(map, difficulty)` builds it off the main thread; a three-minute song takes about a second.
