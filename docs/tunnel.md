# The tunnel

`src/games/tunnel` is Waveland's second game: a race down a 3D tunnel built from the song, like Audiosurf or Thumper. It reads the same `LevelMap` from the core as the platformer and never analyses audio itself. Three.js draws it.

This file is the tunnel's reference, like `docs/platformer.md`: the design, the track and its grammar, the proof that every track can be raced clean, scoring and the look. What is still open is at the end (Open points).

## The design

A song-locked rail racer. The player never controls speed: their distance down the tunnel comes only from song time, `zAtTime(track, t)`, the integral of a speed per tempo segment (eased over a beat at each change, the same scheme as the platformer's scroll), so they reach each thing on its beat. Depth comes from steering and two actions:

- **Steer**: hop one lane left or right, `LANE_HOP_TIME` (0.12 s, eased) per hop; a hop pressed mid-hop turns from where the racer is toward the next lane over. Held, it hops again every `LANE_REPEAT` (half a beat; the run turns holding into presses). Lanes are slots on the tunnel's lower arc: 3 on easy, 5 on normal and hard. Across the tunnel the physics works in lane units (a lane is one unit, whatever the tube's radius), so the look can widen and pulse the tube without moving a lane.
- **Jump**: a short hop over low walls: `JUMP_AIR` (0.32 s) in the air, peaking at `JUMP_HEIGHT` (0.8); feet at `LOW_WALL_HEIGHT` (0.3) or higher clear a low wall. The tunnel's answer to the platformer's jump. Only from the floor; steering works in the air.
- **Overdrive**: the platformer's overdrive (4 bars ×2), on its own bindable button.

No dash or slam: the tunnel's depth is lanes and timing, not a move set. The controls are their own actions (`left`, `right`, plus the shared `jump` and `overdrive`; `controls` on the tunnel's `GameDefinition`), bound in Settings under the game picker's Tunnel: by default ← or A and → or D, d-pad left and right on a gamepad, no mouse button. Bindings are shared by every game (jump is the same key in both), but an input only moves between actions some game uses together (`rivalActions`), so the tunnel's left may share a key with the platformer's slam.

**No deaths.** The music never stops for a crash: hitting an obstacle breaks the combo, costs points and a shield, flashes orange and shakes the camera (both off with reduced effects). Rank counts crashes instead of deaths. A race that stops and rewinds kills the flow these games are known for; the platformer keeps the checkpoint model.

## The track: what the music shapes

The track is pure data built from the `LevelMap` (in `level/`, run in a worker like the platformer's), the same for the same song and difficulty: `TunnelTrack` in `level/track.ts`, built by `generateLevel(map, difficulty)` in `level/generate.ts`.

- **Distance** (`run`; `zAtTime`, `speedAt`, `timeAtZ`): down the tunnel is `z`, in track units (a lane is one unit wide). Each tempo segment runs at `runSpeed` of its tempo: the tempo folded into 80–160 BPM, `Z_PER_FOLDED_BEAT` (6) units per folded beat, so 8–16 units/s. At a tempo change the run eases to the next segment's speed over that segment's first beat, and a switch to half or double time keeps its speed (`runFor`, the platformer's scroll's scheme). The racer's front is at `zAtTime(track, t)`; every obstacle and pickup is placed with it, so the racer meets each on its beat.
- **Path** (`pathFor`, read with `pathAt(track, z)`): one centreline point per grid beat (`x` across, `y` up, `z`, and its `heading`), plus one at song time 0. The melody bends and climbs it:
  - **Climb**: the melody's height (`LevelMap.mood.melody`) sets the climb, up to `CLIMB_RANGE` (4 units) over the song's own range. It eases a third of the way each beat, at most `MAX_CLIMB` (0.35) a beat.
  - **Bend**: the melody's movement (`mood.melodyMove`) sets the bend: rising turns right, falling left, up to `MAX_TURN` (0.04 rad of heading) a beat, eased in; a held note straightens it.
  - **Cap**: the heading never passes `MAX_HEADING` (0.3 rad), so the far end of the tunnel stays on screen (eight beats ahead it has turned 0.32 rad at most).
  - **No melody** (`none`): the path has no climb or bend of its own. It holds the last heard height and straightens.
- **Pulse** (`pulse`): the bass per beat (`LevelMap.bass`) and every kick with its strength, for the renderer to pulse the tube's radius and ring glow. Visual only, like the platformer's kick and snare pulses: it never moves a lane.
- **Width and look per section feel** (`looks`: one `SectionLook` for each section, from `LevelMap.moods`): the tube's radius (a share of the usual, at the section's start and end), the beats between its rings of light, its glow, whether it has ring walls on every beat and how fast they turn (`spin`), how far the tube opens on each beat (`burst`) and whether it has a starfield (`stars`). By feel:

  | Feel | Radius | Rings | Ring walls | Burst | Stars |
  |---|---|---|---|---|---|
  | Calm, breakdown | 1.35 (wide) | every 4 beats (sparse) | — | — | yes |
  | Groove | 1 | every beat | — | — | — |
  | Chorus | 0.9, brighter | every beat | every beat, turning 0.3 rad a beat | 3% | — |
  | Build | narrows from 1 to 0.8 | every half beat | — | — | — |
  | Drop | 1.5 (bursts open) | every beat | — | 10% | — |

  The burst is on every beat: full on the downbeat and 45% on the others.

  The drop's set piece: `DROP_BARS` (2 bars) with every lane open and a wave of gems in every lane on each beat.
- **Dark** (`dark`): every stop of the song, the tunnel dark and empty until the band comes back.

## The music-to-obstacle grammar

As in the platformer, every obstacle comes from a musical moment and the music sizes it; difficulty only leaves common ones out or makes them smaller, never moves them. Randomness only picks lanes, the one thing the music leaves open: `Moment.pick`, seeded from `LevelMap.seed`, the difficulty and the moment's beat, so a repeat keeps its lanes.

**On the pulse.** A dense real rock song had kicks and snares on nearly every sixteenth, and an obstacle there is noise nobody hears. On easy and normal a kick, a snare or an accent's wall is only a moment on a beat or an "and" (within `ON_PULSE`, 0.08 beat); on hard (`sixteenths`) the sixteenths count too. A syncopation that is the song's texture (more than `SYNC_PER_BAR`, 1.5 a bar, over `SYNC_WINDOW`, 16 beats either side) gets no sliding block. Among a bar's common moments the planner prefers, in order: the positions the bar a phrase back used (so a part keeps its pattern even where the song isn't heard to repeat), those on a beat before the "ands", then the strongest. The same rule as the platformer's "On the pulse" (`docs/platformer.md`).

In `generate.ts`, `momentsOf` turns each moment into a candidate with the beats it takes up (from its approach to the free track after it), `planBars` picks each bar's, and `compose` builds them. Every obstacle (`Obstacle`) keeps its label and reason ("Wall", "accent: through the gap") and, for a repeat, the bar it repeats.

| Musical moment | Obstacle | Sized by |
|---|---|---|
| Kick | A block in one lane, on the kick's time (`kick`) | Two lanes for a kick at least `twoLane` strong (normal 0.8, hard 0.6, never on easy) |
| Snare | A block on the other side of the centre from the last kick's block (`snare`): its mirror, or beside the centre when the kick's block was about the centre. A groove steers left-right with the beat | — |
| Accent | A wall across every lane but `gaps` (two on easy, one on normal and hard), with a beat and a half of free track before it to steer to the gap (`wall`). The gap starts at the picked lane and widens on the side nearer the centre (`gapLanes`) | At least `lowAccent` strong (0.95, 0.85, 0.75): a low wall across every lane, to jump (`low`) |
| Held sound | Not an obstacle, something to ride (`holds`): while a note holds, a rail of gems every half beat along the lane the obstacles block least; while a chord or a cymbal rings, a ring of light across the tunnel | As long as it holds, up to 8 beats |
| Stop | The tunnel goes dark and empty (`dark`; the planner lets nothing else in), and the band's return lands a wall with the difficulty's gaps (`stop`). The empty dark is the time to steer to the gap | — |
| Syncopation (hard) | A block sliding one lane across over the half beat before the off-beat, in the target lane when the racer meets it (`slide`, `Obstacle.slide`). The physics reads the block where it is | — |
| Fill | A slalom: one block a hit, alternating sides (`slalom`); hits under a quarter beat apart are thinned. On hard the block covers the centre lane too wherever the hits are at least `WEAVE_TIME` (0.36 s) apart, so the racer weaves across. It ends in a boost hoop on the bar line (Pickups) | — |
| Build | The squeeze (`squeeze`): the last bar of a build narrows. Three walls on beats 1, 2 and 3 of the build's last bar (the last bar with three beats before the section's end), each leaving fewer lanes open round one picked lane (easy 2, 2, 2 of 3; normal 3, 3, 2 of 5; hard 3, 2, 1 of 5), with 0.75 beat of free track before the first. A line of gems runs down the lane open in all three, every half beat through the bar | — |
| Drop | Its set piece: `DROP_BARS` (2) bars of open track with a wave of gems in every lane on each beat | — |

**How many.** Stops, accents and fills (`RARE`) always become obstacles when they fit. Kicks, snares and syncopations are common, and equals: the stronger hit wins. A bar gets as many as the music is busy (its kicks and snares per beat and its energy), times the difficulty's `hazard` and `COMMON_PER_BAR` (4), the fractions carried from bar to bar, in the order above (phrase back, on the beat, strength), never overlapping.

**The floor.** A steady four-on-the-floor beat has few kicks and snares per beat, so its activity rates low even where it is busy. Every bar of a groove or a build has at least `busyFloor` obstacles, and of a chorus or a drop at least `peakFloor` (fractions carried from bar to bar, like the platformer's), taken from the bar's own common moments, so an obstacle is still always on a kick, a snare or a syncopation. Calm sections and breakdowns have none, and a bar that repeats an earlier one copies it. Where a bar's moments overlap (an obstacle takes a beat of track before and after it) the floor is the most that fits.

**Where a kick's block stands.** `lean` (easy 0.4, normal 0.2, hard 0): that share of the seeded picks puts a kick's block in the centre lane, where the racer starts and the gems' line runs (`leanedLane`); the rest pick any lane. It is a function of the pick alone, so a repeated bar keeps its lanes; the snare still answers on the other side. Only kicks and snares at least `minHit` strong are moments (0.55, 0.4, 0.3). Calm sections and breakdowns leave out snares and slides and halve the rest; a build gets up to `BUILD_DENSER` (80%) more by its end.

**Repeats.** A bar the song plays again (`BarInfo.repeats`) takes the obstacles that bar had a phrase (`PHRASE_BARS`, 4 bars) back, or the first time it was played, each on its own moment there, in the same lanes. A loop of a bar or two plans its first phrase afresh and repeats that. A drop's set piece is never a repeat's source: a bar sounding like one is planned afresh.

**Pickups** (magenta, scoring; `pickupsFor`): the drops' waves, the rails, the squeeze's line, and gems on hi-hats (every `gemEvery`-th: every other one on easy and normal, every one on hard), and on off-beats with no hats within a beat (not in a squeeze's bar). The gems follow a line: each takes the free lane nearest the last gem's. A gem is:

- never within `GEM_CLEAR` (0.15 s) of an obstacle in its lane;
- never in the dark;
- at least a quarter beat from another gem in its lane;
- never in a lane that an obstacle in the next `GEM_LOOKAHEAD` (0.8 s) blocks, unless the nearest free lane can be reached in time (`LANE_HOP_TIME` a lane plus a 0.15 s reaction).

**Boosters** (`track.boosters`, collectable; never needed, so the validator never sees them): at most one a section (`looks`), on one of its first `BOOSTER_BARS` (4) free downbeats (not in a stop's dark, a drop's set piece or within `EXTRA_EDGE`, 2 s, of the run-in or run-out), at least `BOOSTER_GAP_BARS` (6) bars after the last. Its lane is the lane of the gems' line (the lane of the last hi-hat gem before it) or one beside it, the nearest that is clear of every obstacle by `EXTRA_CLEAR` (0.3 s) and passes the gems' own `fits` check, so a player chasing gems reaches it. Which one (`boosterFor`): a build a **shield** (ready for the drop), a chorus or a drop a **surge** (the gems are thick), anything else a **magnet**; never the same kind twice in a row (the next in magnet, surge, shield instead). What they do is in Scoring.

**Boost hoops** (`track.hoops`, magenta, bonus only, never needed):

- *Phrase hoops*: in a chorus or a drop section, four hoops on the downbeats of its first phrase of `HOOP_BARS` (4) free bars (a drop's set piece is skipped), and a second phrase `HOOP_AGAIN_BARS` (8) bars on when the section is long enough. Each hoop is in a lane at most one from the last (it starts at the gems' line, and a seeded direction is preferred), clear of obstacles like a booster. A phrase that doesn't fit all four is left out.
- *Fill hoops*: a fill's slalom ends in one hoop on the bar line the fill leads into, in a lane the last block leaves open (the nearest to the centre).

**Difficulty** (`DIFFICULTY` in `generate.ts`):

| | Easy | Normal | Hard |
|---|---|---|---|
| Lanes | 3 | 5 | 5 |
| Common moments used (`hazard`) | 0.4 | 0.65 | 1 |
| Weakest kick or snare (`minHit`) | 0.55 | 0.4 | 0.3 |
| Two-lane kicks (`twoLane`) | never | ≥ 0.8 | ≥ 0.6 |
| Gap lanes in a wall (`gaps`) | 2 | 1 | 1 |
| Low walls (`lowAccent`) | ≥ 0.95 | ≥ 0.85 | ≥ 0.75 |
| Sliding blocks, weaving slaloms | no | no | yes |
| Gems on hi-hats (`gemEvery`) | every other | every other | every one |
| Sixteenths as moments (`sixteenths`) | no | no | yes |
| Obstacles a bar has at least (`busyFloor` groove or build, `peakFloor` chorus or drop) | 0.5, 1 | 1, 1.75 | 1.75, 3 |
| Share of kick blocks in the centre lane (`lean`) | 0.4 | 0.2 | 0 |
| Lanes open in a squeeze's walls (`squeeze`) | 2, 2, 2 | 3, 3, 2 | 3, 2, 1 |

On the synthetic test songs (`src/core/analysis/test-songs.ts`), as tuned by the playtest: obstacles a minute, gems a minute, and the hops a minute the solver needs to get through clean (a player chasing gems hops more):

| Song | Easy | Normal | Hard |
|---|---|---|---|
| 170 BPM rock stand-in | 53 · 167 gems · 18 hops | 77 · 175 · 49 | 118 · 302 · 50 |
| 128 BPM electronic track | 27 · 78 · 7 | 39 · 91 · 17 | 48 · 137 · 15 |
| Melody song (120 BPM) | 19 · 170 · 6 | 37 · 168 · 40 | 59 · 250 · 13 |

(Measured after the pulse, floor and lean changes and the squeeze. The hops are those of the one route `solveLevel` happens to return, which wanders a little, so they are only a rough guide: the melody song's normal 40 is that wandering, not a need.) The electronic track's hard is still only a little busier than normal: its drops are its only busy bars, and a bar there is already as full as the kicks leave room for, so the floor rarely binds. Boosters a song: 7 on the rock stand-in and the electronic track, 1 on the melody song; hoops 18 to 34 on the rock stand-in, 17 on the electronic track, 8 on the melody song.

The rock stand-in's accents are mostly loud (two thirds at 0.7 or more), so on normal and hard most of its accents are low walls to jump; easy keeps them walls to steer through, all but the very loudest.

## Always completable

**The physics** (`src/games/tunnel/physics.ts`): the racer's constants and `stepRacer`, the one step function both the game and the validator run.

- **Steps**: fixed `PHYSICS_DT` (1/60 s) steps at song time, against the track's obstacles (`RacerWorld`; the track's own is `TrackWorld`). The input is presses, `{ left, right, jump }`; `z` is set from `world.zAt(t)` every step, never from input.
- **Jump**: the exact parabola, so it peaks at `JUMP_HEIGHT` and lasts `JUMP_AIR` whatever the step.
- **Hits**: the racer is `RACER_HALF` (0.25 lanes) wide on each side and `RACER_DEPTH` (0.6) long; an obstacle `BLOCK_HALF` (0.4) wide on each side of its lane and `BLOCK_DEPTH` (0.4) deep. They hit when they overlap in depth and across, unless it is a low wall and the feet are high enough. A sliding block is wherever it has slid to at that moment (`obstacleLaneAt`).
- **Crashes**: never stop the racer. The step reports one (`RacerState.crash`, once per obstacle: `lastHit`) and the race goes on.

**The validator** (`level/validate.ts`) is a search over the racer's inputs. With z fixed by time, a candidate is only its lane, where it is in a hop, and its height and speed in a jump.

- Every `DECISION_STEPS` (3) steps each candidate tries doing nothing, hopping left, hopping right and jumping. A new hop is only tried once the one under way is half done, so the search never leans on presses faster than a player's.
- A candidate that crashes is dropped: the run must be clean.
- Candidates in the same state are merged. Every one settled in a lane on the floor is kept; the rest are thinned to 40, spread evenly across the tunnel.
- It can only miss ways through, never invent one.

`validateLevel(track)` runs it over the whole song. `solveLevel(track)` keeps how each candidate got where it is and returns the presses of one clean way through (a map from step to input), for autoplay (dev: `waveland.autoplay()`).

**The generator** builds a stretch at a time and runs the search through it before going on:

- **Stretches**: a bar, or more while a planned obstacle runs past the bar. A moment belongs to the stretch its beat is in, and its last contact plus `PASS_BEATS` (half a beat) must be inside it.
- **Proof**: each stretch's search goes up to the last decision step at or before the stretch's end. The next stretch's obstacles are only met on their moments, at or after its start, so every candidate has only met what is built, and the stretch-by-stretch proof agrees with `validateLevel`.
- **Repairs**: a stretch nobody gets through clean, or that leaves nobody settled in a lane, is built again easier, every obstacle on its own moment:
  1. one lane for every block, still sliding blocks, no centre in a slalom and a gap lane more in every wall;
  2. two more gap lanes;
  3. only its rare moments;
  4. only its most salient one;
  5. empty, which is always passable (`TrackGenerationError` otherwise, which would be a bug).

  `Chunk.repairs` counts the tries; `planned` and `kept` count the obstacles.
- **Deterministic**: seeded by the song's map seed and the difficulty, so the same song at the same difficulty always gives the same track.
- **Time**: the 2:20 rock stand-in builds in about half a second. `generateLevelInWorker(map, difficulty)` (`level/index.ts`, `level/worker.ts`) builds it off the main thread.

**Tests**:

- `physics.test.ts`: hops, jumps, crashes, slides.
- `level/track.test.ts`: the run and the path.
- `level/validate.test.ts`: hand-built tracks (`level/test-track.ts`), and `solveLevel`'s presses replayed through `stepRacer` without a crash.
- `level/generate.test.ts`: each moment of the grammar on its own, every obstacle on its moment, difficulty, determinism, drops, gems, and nine random songs at every difficulty.
- `level/test-songs.test.ts`: every synthetic test song at every difficulty raced without a crash, busier from easy to hard, repeats on the same beats, and the rock stand-in solved on hard and replayed clean.
- `level/pulse.test.ts`: the pulse (easy and normal on a beat or an "and", hard on sixteenths, texture syncopations), a part keeping its pattern a phrase on, the floor, the lean.
- `level/extras.test.ts`: boosters (one a section, six bars apart, on a free first-phrase downbeat, clear of obstacles), hoops (phrases of four a lane apart, a fill's hoop) and the squeeze (narrowing walls, the gem line).

Boosters and hoops are put on the finished track and the validator never sees them, so none is ever needed (`level/extras.test.ts` checks the track validates with them taken away). The squeeze's walls are obstacles like any other: the validator sees them, and a stretch it fails is repaired like the rest (a squeeze's open lanes widen by `ease`).

## Scoring

`TunnelRun` (`run.ts`) is one race, without any drawing: the scene feeds `update(time, input)` the audio clock's time and the controls every frame, and draws what it says and the events it returns. What both games score alike (judging against the beat or eighth, the multiplier, overdrive, count-ins, ranks and their rules in words) is in `src/games/shared/scoring.ts`.

- **Steps**: `stepRacer` in fixed steps up to the song time, at most 240 a frame (a long stall jumps ahead). The input is presses and holds of left, right and jump, and overdrive. A steer press acts on the next step; held, it hops again every `LANE_REPEAT` (half a beat) after the press, until let go. A jump pressed in the air waits `JUMP_BUFFER` (0.1 s) for the floor.
- **Count-in and pause**: a bar of count-in before the song (`countInFrom`, `countInBeats`); after a pause, `holdForResume()` keeps the racer where it stopped while the two beats before it play (`RESUME_BEATS`).
- **Judging**: a hop pressed, or a jump's takeoff, within the shared windows of a beat or eighth is perfect (300) or good (100), judged at the song time it was pressed (`inputLead` before it acts; autoplay's at their own step). Only presses are judged, not a held steer's repeats, and a hop into the side wall isn't one. A miss counts against timing but doesn't break the combo: steering to dodge isn't always on the beat, and only a crash breaks it.
- **Pickups**: taken when the racer's length passes over one and its middle is within `PICKUP_REACH` (half a lane) of its lane, in the air too. A gem scores 100 and fills the overdrive meter by 1/40, a rail's gem 50 and 1/80.
- **Boosters** (taken like a pickup, 250 points and 1/40 of the meter, adding to the combo): the **shield** puts up a shield, as a clean section does (none is added when one is up); the **magnet** runs for `BOOSTER_BEATS.magnet` (8 beats, two bars) and takes gems and rails within `MAGNET_REACH` (1.5 lanes) of the racer, so those in the lanes beside it too; the **surge** runs for 8 beats and doubles (`SURGE_FACTOR`) what gems, rails and hoops (and the hoop streak) score, on top of the multiplier and overdrive. The timed ones are in `TunnelRun.magnet` and `surge` (`from`, `until`); one taken again while it runs starts over. The shield, magnet and surge each have a HUD slot (`ui.ts`; the timed ones with a bar for the time left) and a word under the count-in when taken.
- **Hoops**: flown through when the racer's length passes the hoop and its middle is within `HOOP_REACH` (0.6 lane) of its lane, at any height. A hoop scores 400 and 1/30 of the meter and adds to the combo; every hoop of a phrase in a row (none missed, none out of turn) earns `HOOP_STREAK_BONUS` (2000, times the multiplier) with the fourth (`RunEvent` `hoop`: `streak`, `bonus`). A single fill hoop has no streak.
- **Combo**: every perfect, good and pickup adds one; every `COMBO_STEP` (8) raises the multiplier, up to ×4.
- **Overdrive**: the shared one. A perfect fills the meter by 1/12; full, the overdrive button doubles the score for 4 bars, with `DOWNBEAT_BONUS` (1000, times the multiplier) when activated on a downbeat. The meter doesn't fill while it runs.
- **Crashes**: no deaths, the music never stops. A crash breaks the combo, costs `CRASH_PENALTY` (500, never below zero) and emits a `crash` event with the obstacle, for the scene to flash orange and shake on. With a shield, the shield goes instead of the points (a save); the combo still breaks and it still counts as a crash.
- **Sections**: each section (`track.looks`) got through without a crash scores `CLEAN_BONUS` (2000) when it ends, and gives the racer a shield if it has none. The shield can also be picked up (Boosters); the validator needs neither.
- **Finish**: when the song ends; the last section ends with it.
- **Results** (`results()`, `summaryOf` for the shared results screen, `rankRules()`): score, timing ((perfects + half the goods) / judged), perfects, goods, misses, crashes, hoops taken of all, shield saves, pickups taken of all, boosters taken of all, best combo, overdrives, clean sections. The rank (boosters and hoops are bonuses and never count in it):

  | Rank | Timing | Pickups taken | Crashes |
  |---|---|---|---|
  | S | 80%+ | 90%+ | none |
  | A | 65%+ | 75%+ | at most 3 |
  | B | 50%+ | 50%+ | any |
  | C | finished | | |

- **Autoplay**: `run.autoplay = solveLevel(track)` plays the solver's presses instead of the player's (dev: `waveland.autoplay()`).

Tests (`run.test.ts`): count-in and pause, crashes and their cost, hops and jumps judged and buffered, held steering, pickups and the multiplier, overdrive, clean sections and the shield, the boosters (a taken shield, the magnet's reach and its end, the surge's doubling), hoops and their streak (full, broken, single), results and rank, and the 128 BPM electronic test song autoplayed on normal to the end with no crash.

The results screen and pause menu are the shared ones (`src/games/shared/menus.ts`): the run gives the results screen its score, rank, two columns of rows and the rank rules in words (crashes instead of deaths), and the pause menu its actions. The HUD is the shared one too (`src/games/shared/hud.ts`: song, beat dots, score and combo meter with the run's combo step and top multiplier, overdrive with what fills it, progress with the drops, count-in, frame rate), with any tunnel-only slots added after the overdrive meter (`hud.status`).

## Look

Neon arcade (`docs/concept/look.html`), drawn in code with Three.js (`scene.ts`, `TunnelScene`): no textures or models, only a radial glow drawn once on a canvas. Three.js is loaded with a dynamic import when the game starts (`index.ts`), like the platformer's Phaser, so it is its own chunk.

Colours keep their meanings, all from `src/theme/palette.ts`: cyan the craft and the lane lines (safe paths), violet the tube, its rings and the bass pulse, magenta gems, rails, kick rings and drops, orange obstacles, on night `#07060f`.

**Where things are.** Track units throughout (a lane is one unit). The path's point is the tube's centre; its frame (forward, right, up) comes from the path a unit either side. The lanes sit one unit apart on the deck, an arc of `LANE_RADIUS` (3) below the centre, so the outer lanes tilt up the tube's side. The tube's rings are wider (`TUBE_RADIUS`, 4.6, times the section's radius share, eased from its start to its end) and breathe with the bass and the kicks; the deck never moves, so a lane is where the physics says. Everything is placed from song time: a ring on its beat (`zAtTime` of the beat's time), an obstacle on its moment, a sliding block where it has slid to now.

**What is drawn**, rebuilt every frame from the stretch in view (`VIEW_BEHIND` 8 units behind the craft to the quality's `viewAhead`), fading into the night far ahead:

- **Rings** of light every `ringBeats` of the section's look, brighter on downbeats and with the section's glow; in a chorus, ring walls on every beat: six separate gates round the tube (so the turning shows), turning `spin` radians a beat with a little kick nudge, each wall the other way round from the last (at 40% with reduced effects). Instanced tori and one merged gate geometry.
- **Beat marks**: a magenta mark across the deck (one strip a lane) at every beat, bright on the downbeat, so the pulse can be counted at deck level; the craft's front passes each on its beat.
- **Telegraphs**: over the beat before each obstacle (a beat and a half before a wall, a stop's wall and a squeeze's walls) its blocked lanes carry an orange strip fading in towards it (in the lane a sliding block ends in); a wall's open lanes carry a cyan strip, the safe path.
- **Starfield** (calm parts and breakdowns): up to `MAX_STARS` (420) dim violet points inside the tube, fixed in the world at places repeating every view length, twinkling and brightening a little with the bass. One `Points` buffer, filled every frame without allocating.
- **Lane lines** (cyan, the deck's edges brighter), a faint floor per lane, and ten long violet lines along the tube. Flat strips rebuilt into one buffer (`Ribbons`), since WebGL lines are a pixel wide.
- **Obstacles**: an orange box per blocked lane, bright edges and a dim fill (an edge shader); a low wall is `LOW_WALL_HEIGHT` tall. The one just hit flares white.
- **Pickups**: spinning magenta octahedra floating over their lane, gone once taken; rails are a magenta strip along their lane, a held chord's ring is magenta rings every 2 units of it. With the magnet on, gems within its reach fly sideways into the craft over their last `MAGNET_PULL` (6) units.
- **Boosters**: a bright core (an icosahedron) in two turning halos, floating over its lane: cyan a shield, magenta a magnet, white-hot a surge. While the magnet runs a flat magenta ring pulses round the craft, while the surge runs an upright white-hot ring spins round it.
- **Boost hoops**: magenta rings (`HOOP_RADIUS` 0.62) standing in their lane `HOOP_HEIGHT` (0.55) over the deck, brightening on the beat, gone once flown through; a full phrase bursts white-hot sparks.
- **The craft**: a cyan dart with a light rim and an engine glow, on its lane (between two mid-hop), at its jump height, banked with the deck, leaning into a hop. The shield is a cyan wireframe bubble round it.
- **Pulse**: on every kick a magenta ring opens out just ahead of the craft (brighter in a drop) and the rings brighten; the tube breathes 5% with the bass and 5% with the kick, and a drop's burst opens it a further 10% on every beat.
- **Stops**: everything in a stop's dark is down to `DARK_LIGHT` (7%).
- **Drop set piece**: from the drop's first bar for `DROP_BARS`, its rings are magenta and flash on every beat, the far end's glow turns magenta, bloom goes up. Overdrive turns the rings magenta too.
- **Crash**: an orange flash over the screen (a CSS layer under the HUD) and a 0.35 s camera shake; sparks (orange, cyan when the shield took it). Sparks also burst on pickups, perfects, overdrive and a new shield.
- **Bloom** (`UnrealBloomPass`) then the output pass. The renderer turns the clear colour to sRGB even inside the composer's linear buffer, so the clear colour is given pre-linearised once more, or night shows as grey.

**Camera.** Behind the craft (`CAMERA_BACK`, 4.6 units, more on a narrow screen so every lane stays in view) and `CAMERA_UP` (1.75) over the deck, following the craft's lane halfway, its frame averaged over 6 units of path so bends come in smoothly, looking `LOOK_AHEAD` (12) units ahead and banking a little with the deck. The field of view aims at 78° across, between 55° and 88° up and down, so a phone held upright still sees every lane.

**Reduced effects** (Settings, or the system's reduced motion): no crash flash or shake, no drop flashes, kick and bass pulses, the chorus gates' turning and the drop's burst at 40%.

**Frame monitor**: the shared `FrameMonitor` (`src/games/shared/perf.ts`) steps down `QUALITY` (`perf.ts`) when frames stay slow: pixel ratio 2, then 1.25 with a shorter view, then 1 without bloom and a 65-unit view, fewer sparks each step. A step down is said in Settings while the game runs. Resizing refits the renderer, the composer and the camera; stopping disposes every geometry, material, texture, the composer and the renderer.

**The session** (`game.ts`, `TunnelSession`) is the platformer's: the audio clock, `GameControls` with the tunnel's actions (`actions.ts`), the shared pause menu (listing left, right, jump, overdrive and pause), results screen and HUD with the booster slots (shield, magnet, surge) and the last judgement word (`ui.ts`), the count-in, tab-hidden pause, settings changes, `DisplayLead`, and dev autoplay (`waveland.autoplay()`, `solveLevel` on the main thread).

## How it was built, and decisions worth keeping

Built in six steps (Nov 2026): the shared game parts moved out of the platformer (HUD, menus, scoring, controls reader, frame monitor in `src/games/shared/`), the melody contour in the core (`docs/core.md`, The melody), the track, the run, the game, and a playtest. Decided along the way, and still how it works:

- Held sounds are rails and rings to ride, never obstacles.
- A stop's wall comes on the band's return, with a gap; the dark, empty stop is the time to steer to it.
- Kicks, snares and syncopations are equals ranked by strength, so the loudest hits get a bar's blocks; a snare answers the middle of the kick's block.
- A drop's set piece is never a repeat's source.
- A missed hop or jump counts against timing but doesn't break the combo; only a crash does. Only steer presses are judged, not a held steer's repeats.
- The shield is earned by a clean section or picked up, and takes a crash's points, not the combo. Boosters and hoops are bonuses the generator puts where the gems' line is, after the validator has proved the track: never needed, so a player who ignores them is never worse off than the validator's route.
- A pickup's lane comes from the gems' line, not from the validator's route: the route is any clean line, the gems' line is what a player chasing gems follows.
- The rank counts pickups taken as well as timing and crashes.
- `melodyMove` `none` means "no climb or bend of its own here", not "follow the filled-in height".

**The playtest** (step 6) played the three synthetic test songs at every difficulty in a browser, with autoplay and the real keys, measured every track (obstacles, gems and the solver's hops a minute, gaps between obstacles, the path's heading and how far off the craft's heading the tunnel 40 units ahead is), and tuned:

- **Density**: `hazard` up from 0.35, 0.55 and 0.9 to 0.4, 0.65 and 1: normal on the 128 BPM track needed a hop only every 4 s, easy barely ever. Every track still validates, without repairs on all but the rock stand-in on hard (two stretches).
- **Low walls**: `lowAccent` up from 0.85, 0.75 and 0.7 to 0.95, 0.85 and 0.75. On the rock stand-in nearly every accent was a low wall on every difficulty (14 low walls to 1 wall with a gap on normal); easy now steers through walls (12 walls, 3 low), normal and hard keep jumping the loudest.
- **Gems**: normal takes every other hi-hat, like easy (`gemEvery` 2): every hat at 170 BPM was a gem every 0.2 s (300 a minute) that drowned out the obstacles. Hard keeps them all.
- **HUD**: the tube's rings and walls run behind the HUD everywhere, unlike the platformer's dark sky, so the shared HUD (`src/games/shared/hud.css`) puts a soft night backing behind the song line, the score box and the overdrive meter, and a tight night halo round their letters. On a narrow screen the song line wraps the tempo and difficulty to a line of their own and the title ellipsizes first, so both always show.

Judged right as built, and left alone: lane hop time (0.12 s, inside an eighth at 170 BPM) and its half-beat repeat; the run speeds (8.5 to 15 units/s); the bend and climb (the tunnel 40 units ahead is at most 0.13 rad off the craft's heading on every test song, so the far end never leaves the screen, and the melody song visibly bends both ways up to the 0.3 rad cap); the camera's distance, height and follow, on desktop and phone sizes; a frame's work (about 1.5 ms of script a frame at desktop size).

## Open points

- **Real songs.** Only the synthetic test songs have been played. Real songs should check the melody contour where no lead plays (a bass's harmonics or a chord's loudest note can read as the melody, bending the path for no audible reason), and whether accents on loud masters all saturate to low walls like the rock stand-in's.
- **Steady four-on-the-floor tracks on hard.** Settled as far as the numbers go: a floor of obstacles per busy bar (`busyFloor`, `peakFloor`). On the 128 BPM electronic track hard is still only 48 obstacles a minute against 39 on normal, because its drops are its only busy bars and a bar there is already as full as the kicks leave room for. Counting hats in a bar's activity would change it; only play can say whether it still feels light.
- **Obstacles off the racer's lane.** Settled with `lean`: a share of kick blocks in the centre lane (0.4 on easy). It leans to where the racer starts, not to where it is: a lean that followed the gems' line would make a repeated bar's lanes depend on what went before. Whether easy is now less idle needs play.
- **Everything new is untested by hand.** The telegraph strips, beat marks, boosters, hoops, squeeze, starfield and turning gates were built and tested as data (tracks, the run), not played or looked at: their brightness, size and timing, whether the squeeze reads as a squeeze and whether the surge, magnet and hoops feel worth steering for are for a play and a look to tune (constants at the top of `scene.ts`, `run.ts` and `generate.ts`).
- **A booster or hoop the racer can't reach.** Their lane is the gems' line or beside it and clear of obstacles, but not proved reachable by the validator (which never sees them); dense obstacles just before one may make it a hop too far. Cheap to check: log how many a gem-chasing bot takes.
- **Frame rate on a real phone.** The offscreen browser throttles frames, so the frame monitor and the frame rate can only be judged on a real window and a real phone.
- **The rank's pickup share** (90% for S) is a first guess: autoplay ignores gems, so only real players' runs can tune it.
- **Touch controls**: none yet, like the platformer.
