# Data card — Harbour City vs Old Tower FC

Story scenario: **The Siege** (`siege`) — Twenty-eight shots, one goal, and a wall that almost held forever.

Seed: `2026` · competition: Meridian League · venue: Harbour Bowl, Harbour
Final score: 1–0 · match id: `m-e08b11dd`

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
npm run export:dataset -- --scenario siege --seed 2026 --out data
```

## Files

| file | format | rows | notes |
| --- | --- | ---: | --- |
| `match.json` | JSON | 1 | meta, timing, final score, team stats, record counts |
| `events.jsonl` | JSONL | 2194 | the raw match event stream, every field as produced |
| `events.csv` | CSV | 2194 | flat view of the same stream; type-specific columns are empty where they do not apply |
| `candidates.jsonl` | JSONL | 29 | the insight feed after interpretation — one candidate per line, with supporting evidence ids |
| `moments.jsonl` | JSONL | 29 | candidates that passed direction, with verified story copy |
| `moments.csv` | CSV | 29 | flat view of the same stories |
| `players.csv` | CSV | 36 | per-player match stats (distance, top speed, sprints, xG, xT) |
| `cues.json` | JSON | 39 | the compiled cue sheet — timed broadcast graphics with slots and expiry |
| `DATA_CARD.md` | MD | 1 | this file |

## Conventions

- Times are match seconds from kickoff (period 1 starts at 0); minute 45+ wraps through half-time.
- Positions are metres on a 105×68 pitch, origin at the centre spot, home attacks toward +x in the first half.
- Speeds are km/h, distances km (players) or metres (events). xG and xT are model outputs of this pipeline, not third-party numbers.
- `provider` on a story is `template` when the deterministic crew wrote it and `llm` when the recorded studio voice was applied.

## Event stream composition

| value | rows |
| --- | ---: |
| pass | 1228 |
| possession_change | 403 |
| carry | 349 |
| throw_in | 95 |
| shot | 29 |
| tackle | 27 |
| interception | 14 |
| save | 11 |
| block | 8 |
| corner | 8 |
| foul | 7 |
| substitution | 6 |
| kickoff | 3 |
| offside | 2 |
| full_time | 1 |
| half_time | 1 |
| penalty | 1 |
| yellow_card | 1 |

## Stories aired

| value | rows |
| --- | ---: |
| big_chance | 11 |
| big_save | 10 |
| speed_flash | 3 |
| momentum_shift | 2 |
| goal | 1 |
| late_drama | 1 |
| penalty | 1 |

## Cue sheet slots

| value | rows |
| --- | ---: |
| stat_bumper | 16 |
| telestration | 11 |
| lower_third | 5 |
| player_tag | 3 |
| goal_flash | 2 |
| momentum_ribbon | 2 |

## Usage

Exports are covered by the repository license (MIT). If you build on this data,
credit the project and keep the synthetic provenance visible — do not present it
as a record of real matches.
