# Data card — Harbour City vs Northgate United

Story scenario: **Free Play** (`freeplay`) — No script. Pure seeded simulation — every run tells its own story.

Seed: `2026` · competition: Meridian League · venue: Harbour Bowl, Harbour
Final score: 1–0 · match id: `m-be9928da`

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
npm run export:dataset -- --scenario freeplay --seed 2026 --out data
```

## Files

| file | format | rows | notes |
| --- | --- | ---: | --- |
| `match.json` | JSON | 1 | meta, timing, final score, team stats, record counts |
| `events.jsonl` | JSONL | 2205 | the raw match event stream, every field as produced |
| `events.csv` | CSV | 2205 | flat view of the same stream; type-specific columns are empty where they do not apply |
| `candidates.jsonl` | JSONL | 17 | the insight feed after interpretation — one candidate per line, with supporting evidence ids |
| `moments.jsonl` | JSONL | 17 | candidates that passed direction, with verified story copy |
| `moments.csv` | CSV | 17 | flat view of the same stories |
| `players.csv` | CSV | 36 | per-player match stats (distance, top speed, sprints, xG, xT) |
| `cues.json` | JSON | 25 | the compiled cue sheet — timed broadcast graphics with slots and expiry |
| `DATA_CARD.md` | MD | 1 | this file |

## Conventions

- Times are match seconds from kickoff (period 1 starts at 0); minute 45+ wraps through half-time.
- Positions are metres on a 105×68 pitch, origin at the centre spot, home attacks toward +x in the first half.
- Speeds are km/h, distances km (players) or metres (events). xG and xT are model outputs of this pipeline, not third-party numbers.
- `provider` on a story is `template` when the deterministic crew wrote it and `llm` when the recorded studio voice was applied.

## Event stream composition

| value | rows |
| --- | ---: |
| pass | 1220 |
| possession_change | 448 |
| carry | 263 |
| throw_in | 110 |
| tackle | 74 |
| foul | 24 |
| shot | 18 |
| interception | 7 |
| save | 7 |
| yellow_card | 7 |
| corner | 6 |
| substitution | 6 |
| block | 5 |
| kickoff | 3 |
| offside | 3 |
| red_card | 2 |
| full_time | 1 |
| half_time | 1 |

## Stories aired

| value | rows |
| --- | ---: |
| big_save | 6 |
| big_chance | 4 |
| speed_flash | 3 |
| red_card | 2 |
| goal | 1 |
| momentum_shift | 1 |

## Cue sheet slots

| value | rows |
| --- | ---: |
| stat_bumper | 12 |
| lower_third | 4 |
| telestration | 4 |
| player_tag | 3 |
| goal_flash | 1 |
| momentum_ribbon | 1 |

## Usage

Exports are covered by the repository license (MIT). If you build on this data,
credit the project and keep the synthetic provenance visible — do not present it
as a record of real matches.
