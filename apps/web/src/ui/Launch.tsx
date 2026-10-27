import { useState } from 'react';
import { SCENARIO_CARDS } from './catalog';
import { useAppStore } from '../state/store';

const STAGES = ['Ingest', 'Interpret', 'Explain', 'Render', 'Personalize'];

export function Launch() {
  const [selected, setSelected] = useState('comeback');
  const [seed, setSeed] = useState(2026);
  const ensurePrepared = useAppStore((state) => state.ensurePrepared);

  const start = () => {
    const card = SCENARIO_CARDS.find((c) => c.id === selected);
    void ensurePrepared(card?.id ?? null, seed, null);
  };

  return (
    <div className="launch">
      <header className="launch-hero">
        <div className="wordmark">
          <span className="wordmark-lamp" aria-hidden />
          <h1>
            FLOOD<span>LIGHT</span>
          </h1>
        </div>
        <p className="tagline">Every moment, under the floodlights.</p>
        <p className="pitch">
          A live football intelligence pipeline. Synthetic match events go in — football-realistic, evidence-checked
          broadcast storytelling comes out. Two teams, one clock, and a production crew that never blinks.
        </p>
        <div className="stage-strip" aria-label="Pipeline stages">
          {STAGES.map((stage, index) => (
            <div className="stage-pill" key={stage}>
              <span className="stage-index">{index + 1}</span>
              {stage}
            </div>
          ))}
        </div>
      </header>

      <section className="scenario-grid" aria-label="Matches">
        {SCENARIO_CARDS.map((card) => (
          <button
            type="button"
            key={card.id}
            className={`scenario-card${selected === card.id ? ' selected' : ''}`}
            onClick={() => setSelected(card.id)}
          >
            <div className="scenario-teams">
              <span className="kit-chip" style={{ background: card.home.primary, color: card.home.onPrimary }}>
                {card.home.abbr}
              </span>
              <span className="vs">v</span>
              <span className="kit-chip" style={{ background: card.away.primary, color: card.away.onPrimary }}>
                {card.away.abbr}
              </span>
            </div>
            <h2>{card.name}</h2>
            <p className="scenario-tagline">{card.tagline}</p>
            <p className="scenario-beat">
              <span>Focus</span> {card.beat}
            </p>
          </button>
        ))}
      </section>

      <section className="launch-controls">
        <label className="seed-field">
          <span>Seed</span>
          <input
            type="number"
            value={seed}
            onChange={(event) => setSeed(Number(event.target.value) || 1)}
            min={1}
          />
          <button
            type="button"
            className="ghost"
            onClick={() => setSeed(Math.floor(Math.random() * 90000) + 10000)}
            title="Draw a new seed"
          >
            shuffle
          </button>
        </label>
        <label className="studio-toggle">
          <span className="evidence-note">Evidence-bound narration · verified against this match</span>
        </label>
        <button type="button" className="cta" onClick={start}>
          Take to air
        </button>
      </section>

      <footer className="launch-foot">
        All clubs, players and matches are fictional. Every match is generated from its seed; every aired number is
        checked against that match's evidence. Narration is rendered from that evidence and never from unbound prose.
      </footer>
    </div>
  );
}
