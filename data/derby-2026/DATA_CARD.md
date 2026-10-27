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
| `events.jsonl` | JSONL | 1997 | the raw match event stream, every field as produced |
| `events.csv` | CSV | 1997 | flat view of the same stream; type-specific columns are empty where they do not apply |
| `candidates.jsonl` | JSONL | 51 | the insight feed after interpretation — one candidate per line, with supporting evidence ids |
| `moments.jsonl` | JSONL | 48 | candidates that passed direction, with verified story copy |
| `moments.csv` | CSV | 48 | flat view of the same stories |
| `players.csv` | CSV | 36 | per-player match stats (distance, top speed, sprints, xG, xT) |
| `cues.json` | JSON | 74 | the compiled cue sheet — timed broadcast graphics with slots and expiry |
| `DATA_CARD.md` | MD | 1 | this file |

## Conventions

- Times are match seconds from kickoff (period 1 starts at 0); minute 45+ wraps through half-time.
- Positions are metres on a 105×68 pitch, origin at the centre spot, home attacks toward +x in the first half.
- Speeds are km/h, distances km (players) or metres (events). xG and xT are model outputs of this pipeline, not third-party numbers.
- `provider` on a story is `template` when the deterministic crew wrote it and `llm` when the recorded studio voice was applied.

## Event stream composition

| value | rows |
| --- | ---: |
| pass | 1106 |
| possession_change | 354 |
| carry | 318 |
| throw_in | 68 |
| shot | 40 |
| tackle | 18 |
| corner | 17 |
| save | 15 |
| interception | 13 |
| foul | 10 |
| block | 9 |
| kickoff | 9 |
| substitution | 6 |
| var_check | 6 |
| goal_kick | 2 |
| penalty | 2 |
| full_time | 1 |
| half_time | 1 |
| red_card | 1 |
| yellow_card | 1 |

## Stories aired

| value | rows |
| --- | ---: |
| big_save | 13 |
| big_chance | 7 |
| goal | 7 |
| milestone | 4 |
| siege | 4 |
| momentum_shift | 3 |
| speed_flash | 3 |
| penalty | 2 |
| var_review | 2 |
| late_drama | 1 |
| red_card | 1 |
| var_overturn | 1 |

## Cue sheet slots

| value | rows |
| --- | ---: |
| stat_bumper | 33 |
| lower_third | 16 |
| goal_flash | 9 |
| telestration | 7 |
| momentum_ribbon | 6 |
| player_tag | 3 |

## Usage

Exports are covered by the repository license (MIT). If you build on this data,
credit the project and keep the synthetic provenance visible — do not present it
as a record of real matches.
