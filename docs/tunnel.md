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
- **Width and look per section feel** (`looks`: one `SectionLook` for each section, from `LevelMap.moods`): the tube's radius (a share of the usual, at the section's start and end), the beats between its rings of light, its glow, and whether it has ring walls on every beat. By feel:

  | Feel | Radius | Rings | Ring walls |
  |---|---|---|---|
  | Calm, breakdown | 1.35 (wide) | every 2 beats | — |
  | Groove | 1 | every beat | — |
  | Chorus | 0.9, brighter | every beat | every beat |
  | Build | narrows from 1 to 0.8 | every half beat | — |
  | Drop | 1.5 (bursts open) | every beat | — |

  The drop's set piece: `DROP_BARS` (2 bars) with every lane open and a wave of gems in every lane on each beat.
- **Dark** (`dark`): every stop of the song, the tunnel dark and empty until the band comes back.

## The music-to-obstacle grammar

As in the platformer, every obstacle comes from a musical moment and the music sizes it; difficulty only leaves common ones out or makes them smaller, never moves them. Randomness only picks lanes, the one thing the music leaves open: `Moment.pick`, seeded from `LevelMap.seed`, the difficulty and the moment's beat, so a repeat keeps its lanes.

In `generate.ts`, `momentsOf` turns each moment into a candidate with the beats it takes up (from its approach to the free track after it), `planBars` picks each bar's, and `compose` builds them. Every obstacle (`Obstacle`) keeps its label and reason ("Wall", "accent: through the gap") and, for a repeat, the bar it repeats.

| Musical moment | Obstacle | Sized by |
|---|---|---|
| Kick | A block in one lane, on the kick's time (`kick`) | Two lanes for a kick at least `twoLane` strong (normal 0.8, hard 0.6, never on easy) |
| Snare | A block on the other side of the centre from the last kick's block (`snare`): its mirror, or beside the centre when the kick's block was about the centre. A groove steers left-right with the beat | — |
| Accent | A wall across every lane but `gaps` (two on easy, one on normal and hard), with a beat and a half of free track before it to steer to the gap (`wall`). The gap starts at the picked lane and widens on the side nearer the centre (`gapLanes`) | At least `lowAccent` strong (0.95, 0.85, 0.75): a low wall across every lane, to jump (`low`) |
| Held sound | Not an obstacle, something to ride (`holds`): while a note holds, a rail of gems every half beat along the lane the obstacles block least; while a chord or a cymbal rings, a ring of light across the tunnel | As long as it holds, up to 8 beats |
| Stop | The tunnel goes dark and empty (`dark`; the planner lets nothing else in), and the band's return lands a wall with the difficulty's gaps (`stop`). The empty dark is the time to steer to the gap | — |
| Syncopation (hard) | A block sliding one lane across over the half beat before the off-beat, in the target lane when the racer meets it (`slide`, `Obstacle.slide`). The physics reads the block where it is | — |
| Fill | A slalom: one block a hit, alternating sides (`slalom`); hits under a quarter beat apart are thinned. On hard the block covers the centre lane too wherever the hits are at least `WEAVE_TIME` (0.36 s) apart, so the racer weaves across | — |
| Drop | Its set piece: `DROP_BARS` (2) bars of open track with a wave of gems in every lane on each beat | — |

**How many.** Stops, accents and fills (`RARE`) always become obstacles when they fit. Kicks, snares and syncopations are common, and equals: the stronger hit wins. A bar gets as many as the music is busy (its kicks and snares per beat and its energy), times the difficulty's `hazard` and `COMMON_PER_BAR` (4), the fractions carried from bar to bar, strongest first, never overlapping. Only kicks and snares at least `minHit` strong are moments (0.55, 0.4, 0.3). Calm sections and breakdowns leave out snares and slides and halve the rest; a build gets up to `BUILD_DENSER` (80%) more by its end.

**Repeats.** A bar the song plays again (`BarInfo.repeats`) takes the obstacles that bar had a phrase (`PHRASE_BARS`, 4 bars) back, or the first time it was played, each on its own moment there, in the same lanes. A loop of a bar or two plans its first phrase afresh and repeats that. A drop's set piece is never a repeat's source: a bar sounding like one is planned afresh.

**Pickups** (magenta, scoring; `pickupsFor`): the drops' waves, the rails, and gems on hi-hats (every `gemEvery`-th: every other one on easy and normal, every one on hard), and on off-beats with no hats within a beat. The gems follow a line: each takes the free lane nearest the last gem's. A gem is:

- never within `GEM_CLEAR` (0.15 s) of an obstacle in its lane;
- never in the dark;
- at least a quarter beat from another gem in its lane;
- never in a lane that an obstacle in the next `GEM_LOOKAHEAD` (0.8 s) blocks, unless the nearest free lane can be reached in time (`LANE_HOP_TIME` a lane plus a 0.15 s reaction).

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

On the synthetic test songs (`src/core/analysis/test-songs.ts`), as tuned by the playtest: obstacles a minute, gems a minute, and the hops a minute the solver needs to get through clean (a player chasing gems hops more):

| Song | Easy | Normal | Hard |
|---|---|---|---|
| 170 BPM rock stand-in | 49 · 163 gems · 23 hops | 76 · 172 · 29 | 117 · 300 · 59 |
| 128 BPM electronic track | 26 · 73 · 5 | 39 · 86 · 20 | 48 · 132 · 15 |
| Melody song (120 BPM) | 19 · 173 · 0 | 32 · 168 · 3 | 53 · 250 · 16 |

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

The only booster is the shield a clean section earns (Scoring); the validator never sees it, so it is never needed.

## Scoring

`TunnelRun` (`run.ts`) is one race, without any drawing: the scene feeds `update(time, input)` the audio clock's time and the controls every frame, and draws what it says and the events it returns. What both games score alike (judging against the beat or eighth, the multiplier, overdrive, count-ins, ranks and their rules in words) is in `src/games/shared/scoring.ts`.

- **Steps**: `stepRacer` in fixed steps up to the song time, at most 240 a frame (a long stall jumps ahead). The input is presses and holds of left, right and jump, and overdrive. A steer press acts on the next step; held, it hops again every `LANE_REPEAT` (half a beat) after the press, until let go. A jump pressed in the air waits `JUMP_BUFFER` (0.1 s) for the floor.
- **Count-in and pause**: a bar of count-in before the song (`countInFrom`, `countInBeats`); after a pause, `holdForResume()` keeps the racer where it stopped while the two beats before it play (`RESUME_BEATS`).
- **Judging**: a hop pressed, or a jump's takeoff, within the shared windows of a beat or eighth is perfect (300) or good (100), judged at the song time it was pressed (`inputLead` before it acts; autoplay's at their own step). Only presses are judged, not a held steer's repeats, and a hop into the side wall isn't one. A miss counts against timing but doesn't break the combo: steering to dodge isn't always on the beat, and only a crash breaks it.
- **Pickups**: taken when the racer's length passes over one and its middle is within `PICKUP_REACH` (half a lane) of its lane, in the air too. A gem scores 100 and fills the overdrive meter by 1/40, a rail's gem 50 and 1/80.
- **Combo**: every perfect, good and pickup adds one; every `COMBO_STEP` (8) raises the multiplier, up to ×4.
- **Overdrive**: the shared one. A perfect fills the meter by 1/12; full, the overdrive button doubles the score for 4 bars, with `DOWNBEAT_BONUS` (1000, times the multiplier) when activated on a downbeat. The meter doesn't fill while it runs.
- **Crashes**: no deaths, the music never stops. A crash breaks the combo, costs `CRASH_PENALTY` (500, never below zero) and emits a `crash` event with the obstacle, for the scene to flash orange and shake on. With a shield, the shield goes instead of the points (a save); the combo still breaks and it still counts as a crash.
- **Sections**: each section (`track.looks`) got through without a crash scores `CLEAN_BONUS` (2000) when it ends, and gives the racer a shield if it has none. The shield is the tunnel's only booster: earned, never a pickup, so the validator never needs it.
- **Finish**: when the song ends; the last section ends with it.
- **Results** (`results()`, `summaryOf` for the shared results screen, `rankRules()`): score, timing ((perfects + half the goods) / judged), perfects, goods, misses, crashes, shield saves, pickups taken of all, best combo, overdrives, clean sections. The rank:

  | Rank | Timing | Pickups taken | Crashes |
  |---|---|---|---|
  | S | 80%+ | 90%+ | none |
  | A | 65%+ | 75%+ | at most 3 |
  | B | 50%+ | 50%+ | any |
  | C | finished | | |

- **Autoplay**: `run.autoplay = solveLevel(track)` plays the solver's presses instead of the player's (dev: `waveland.autoplay()`).

Tests (`run.test.ts`): count-in and pause, crashes and their cost, hops and jumps judged and buffered, held steering, pickups and the multiplier, overdrive, clean sections and the shield, results and rank, and the 128 BPM electronic test song autoplayed on normal to the end with no crash.

The results screen and pause menu are the shared ones (`src/games/shared/menus.ts`): the run gives the results screen its score, rank, two columns of rows and the rank rules in words (crashes instead of deaths), and the pause menu its actions. The HUD is the shared one too (`src/games/shared/hud.ts`: song, beat dots, score and combo meter with the run's combo step and top multiplier, overdrive with what fills it, progress with the drops, count-in, frame rate), with any tunnel-only slots added after the overdrive meter (`hud.status`).

## Look

Neon arcade (`docs/concept/look.html`), drawn in code with Three.js (`scene.ts`, `TunnelScene`): no textures or models, only a radial glow drawn once on a canvas. Three.js is loaded with a dynamic import when the game starts (`index.ts`), like the platformer's Phaser, so it is its own chunk.

Colours keep their meanings, all from `src/theme/palette.ts`: cyan the craft and the lane lines (safe paths), violet the tube, its rings and the bass pulse, magenta gems, rails, kick rings and drops, orange obstacles, on night `#07060f`.

**Where things are.** Track units throughout (a lane is one unit). The path's point is the tube's centre; its frame (forward, right, up) comes from the path a unit either side. The lanes sit one unit apart on the deck, an arc of `LANE_RADIUS` (3) below the centre, so the outer lanes tilt up the tube's side. The tube's rings are wider (`TUBE_RADIUS`, 4.6, times the section's radius share, eased from its start to its end) and breathe with the bass and the kicks; the deck never moves, so a lane is where the physics says. Everything is placed from song time: a ring on its beat (`zAtTime` of the beat's time), an obstacle on its moment, a sliding block where it has slid to now.

**What is drawn**, rebuilt every frame from the stretch in view (`VIEW_BEHIND` 8 units behind the craft to the quality's `viewAhead`), fading into the night far ahead:

- **Rings** of light every `ringBeats` of the section's look, brighter on downbeats and with the section's glow; ring walls (a glowing band) on every beat in a chorus. Instanced tori.
- **Lane lines** (cyan, the deck's edges brighter), a faint floor per lane, and ten long violet lines along the tube. Flat strips rebuilt into one buffer (`Ribbons`), since WebGL lines are a pixel wide.
- **Obstacles**: an orange box per blocked lane, bright edges and a dim fill (an edge shader); a low wall is `LOW_WALL_HEIGHT` tall. The one just hit flares white.
- **Pickups**: spinning magenta octahedra floating over their lane, gone once taken; rails are a magenta strip along their lane, a held chord's ring is magenta rings every 2 units of it.
- **The craft**: a cyan dart with a light rim and an engine glow, on its lane (between two mid-hop), at its jump height, banked with the deck, leaning into a hop. The shield is a cyan wireframe bubble round it.
- **Pulse**: on every kick a magenta ring opens out just ahead of the craft and the rings brighten; the tube breathes 5% with the bass and 5% with the kick.
- **Stops**: everything in a stop's dark is down to `DARK_LIGHT` (7%).
- **Drop set piece**: from the drop's first bar for `DROP_BARS`, its rings are magenta and flash on every beat, the far end's glow turns magenta, bloom goes up. Overdrive turns the rings magenta too.
- **Crash**: an orange flash over the screen (a CSS layer under the HUD) and a 0.35 s camera shake; sparks (orange, cyan when the shield took it). Sparks also burst on pickups, perfects, overdrive and a new shield.
- **Bloom** (`UnrealBloomPass`) then the output pass. The renderer turns the clear colour to sRGB even inside the composer's linear buffer, so the clear colour is given pre-linearised once more, or night shows as grey.

**Camera.** Behind the craft (`CAMERA_BACK`, 4.6 units, more on a narrow screen so every lane stays in view) and `CAMERA_UP` (1.75) over the deck, following the craft's lane halfway, its frame averaged over 6 units of path so bends come in smoothly, looking `LOOK_AHEAD` (12) units ahead and banking a little with the deck. The field of view aims at 78° across, between 55° and 88° up and down, so a phone held upright still sees every lane.

**Reduced effects** (Settings, or the system's reduced motion): no crash flash or shake, no drop flashes, kick and bass pulses at 40%.

**Frame monitor**: the shared `FrameMonitor` (`src/games/shared/perf.ts`) steps down `QUALITY` (`perf.ts`) when frames stay slow: pixel ratio 2, then 1.25 with a shorter view, then 1 without bloom and a 65-unit view, fewer sparks each step. A step down is said in Settings while the game runs. Resizing refits the renderer, the composer and the camera; stopping disposes every geometry, material, texture, the composer and the renderer.

**The session** (`game.ts`, `TunnelSession`) is the platformer's: the audio clock, `GameControls` with the tunnel's actions (`actions.ts`), the shared pause menu (listing left, right, jump, overdrive and pause), results screen and HUD with the shield slot and the last judgement word (`ui.ts`), the count-in, tab-hidden pause, settings changes, `DisplayLead`, and dev autoplay (`waveland.autoplay()`, `solveLevel` on the main thread).

## How it was built, and decisions worth keeping

Built in six steps (Nov 2026): the shared game parts moved out of the platformer (HUD, menus, scoring, controls reader, frame monitor in `src/games/shared/`), the melody contour in the core (`docs/core.md`, The melody), the track, the run, the game, and a playtest. Decided along the way, and still how it works:

- Held sounds are rails and rings to ride, never obstacles.
- A stop's wall comes on the band's return, with a gap; the dark, empty stop is the time to steer to it.
- Kicks, snares and syncopations are equals ranked by strength, so the loudest hits get a bar's blocks; a snare answers the middle of the kick's block.
- A drop's set piece is never a repeat's source.
- A missed hop or jump counts against timing but doesn't break the combo; only a crash does. Only steer presses are judged, not a held steer's repeats.
- The shield is earned by a clean section, never picked up, and takes a crash's points, not the combo: the track has no booster pickups, so the validator never needs one.
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
- **Steady four-on-the-floor tracks feel light on hard.** On the 128 BPM electronic track hard is only a little busier than normal (48 against 39 obstacles a minute): a bar's share follows its kicks and snares per beat, which a four-on-the-floor beat keeps low, and the track has no syncopations for sliding blocks. A floor for hard, or counting hats in a bar's activity, would change it.
- **Obstacles off the racer's lane.** A kick's block takes a random lane, so on easy many blocks never stand in the way (the solver needs no hop at all on the melody song's easy track); the gems' line is what makes the player move. Leaning a block towards the lane the gems lead to would make easy less idle, at the cost of the "randomness only picks lanes" freedom.
- **Frame rate on a real phone.** The offscreen browser throttles frames, so the frame monitor and the frame rate can only be judged on a real window and a real phone.
- **The rank's pickup share** (90% for S) is a first guess: autoplay ignores gems, so only real players' runs can tune it.
- **Touch controls**: none yet, like the platformer.
