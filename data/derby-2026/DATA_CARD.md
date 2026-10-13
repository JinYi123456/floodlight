# Data card — Ironworks FC vs Westerly Wanderers

Story scenario: **The Derby** (`derby`) — Seven goals, a red card, a VAR overturn — ninety minutes of beautiful chaos.

Seed: `2026` · competition: Meridian League · venue: The Foundry, Ironworks
Final score: 4–3 · match id: `m-2c5e6fb0`

## Provenance

Every row in this export is **synthetic**. There are no real match records, no real
player names and no real club identities anywhere in it: the clubs, squads, venues and
officials are fictional, and the event stream is a seeded stochastic simulation with
authored narrative directives on top. Nothing was scraped, licensed or derived from
real football data.

The run is deterministic. The same scenario and seed produce byte-identical files —
there are no timestamps, no random ids and no machine-dependent values inside.
Regenerate with:

```sh
npm run export:dataset -- --scenario derby --seed 2026 --out data
```

## Files

| file | format | rows | notes |
| --- | --- | ---: | --- |
| `match.json` | JSON | 1 | meta, timing, final score, team stats, record counts |
| `events.jsonl` | JSONL | 2144 | the raw match event stream, every field as produced |
| `events.csv` | CSV | 2144 | flat view of the same stream; type-specific columns are empty where they do not apply |
| `candidates.jsonl` | JSONL | 38 | the insight feed after interpretation — one candidate per line, with supporting evidence ids |
| `moments.jsonl` | JSONL | 37 | candidates that passed direction, with verified story copy |
| `moments.csv` | CSV | 37 | flat view of the same stories |
| `players.csv` | CSV | 36 | per-player match stats (distance, top speed, sprints, xG, xT) |
| `cues.json` | JSON | 61 | the compiled cue sheet — timed broadcast graphics with slots and expiry |
| `DATA_CARD.md` | MD | 1 | this file |

## Conventions

- Times are match seconds from kickoff (period 1 starts at 0); minute 45+ wraps through half-time.
- Positions are metres on a 105×68 pitch, origin at the centre spot, home attacks toward +x in the first half.
- Speeds are km/h, distances km (players) or metres (events). xG and xT are model outputs of this pipeline, not third-party numbers.
- `provider` on a story is `template` when the deterministic crew wrote it and `llm` when the recorded studio voice was applied.

## Event stream composition

| value | rows |
| --- | ---: |
| pass | 1180 |
| possession_change | 416 |
| carry | 335 |
| throw_in | 101 |
| shot | 26 |
| tackle | 18 |
| foul | 12 |
| kickoff | 9 |
| corner | 8 |
| interception | 8 |
| save | 8 |
| substitution | 6 |
| block | 4 |
| offside | 3 |
| yellow_card | 3 |
| red_card | 2 |
| var_check | 2 |
| full_time | 1 |
| half_time | 1 |
| penalty | 1 |

## Stories aired

| value | rows |
| --- | ---: |
| big_chance | 9 |
| big_save | 8 |
| goal | 7 |
| speed_flash | 3 |
| milestone | 2 |
| momentum_shift | 2 |
| red_card | 2 |
| late_drama | 1 |
| penalty | 1 |
| var_overturn | 1 |
| var_review | 1 |

## Cue sheet slots

| value | rows |
| --- | ---: |
| stat_bumper | 24 |
| lower_third | 14 |
| goal_flash | 9 |
| telestration | 9 |
| player_tag | 3 |
| momentum_ribbon | 2 |

## Usage

Exports are covered by the repository license (MIT). If you build on this data,
credit the project and keep the synthetic provenance visible — do not present it
as a record of real matches.
