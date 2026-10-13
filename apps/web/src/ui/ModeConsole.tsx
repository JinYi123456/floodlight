/**
 * The viewer mode console — one match, many audiences. Persona, language,
 * favourite club, favourite player and the metric a viewer cares about all
 * reshape how the same verified intelligence is told.
 */

import { useAppStore } from '../state/store';

const PERSONAS = [
  { id: 'analyst', label: 'Analyst' },
  { id: 'casual', label: 'Casual' },
  { id: 'club', label: 'Club heart' },
  { id: 'player_focus', label: 'Player focus' },
] as const;

const LANGS = [
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Español' },
  { id: 'fr', label: 'Français' },
] as const;

const METRICS = [
  { id: '', label: 'No focus' },
  { id: 'xg', label: 'xG & chances' },
  { id: 'passes', label: 'Passing' },
  { id: 'speed', label: 'Speed' },
  { id: 'distance', label: 'Distance' },
  { id: 'momentum', label: 'Momentum' },
] as const;

export function ModeConsole() {
  const match = useAppStore((state) => state.match);
  const prefs = useAppStore((state) => state.prefs);
  const setPrefs = useAppStore((state) => state.setPrefs);

  if (!match) return null;
  const players = [...match.lineups.home, ...match.lineups.away];

  return (
    <section className="mode-console">
      <h2>Viewer modes</h2>

      <div className="console-row">
        <span className="console-label">Persona</span>
        <div className="segmented">
          {PERSONAS.map((persona) => (
            <button
              type="button"
              key={persona.id}
              className={prefs.persona === persona.id ? 'active' : ''}
              onClick={() => setPrefs({ persona: persona.id })}
            >
              {persona.label}
            </button>
          ))}
        </div>
      </div>

      <div className="console-row">
        <span className="console-label">Language</span>
        <div className="segmented">
          {LANGS.map((lang) => (
            <button
              type="button"
              key={lang.id}
              className={prefs.lang === lang.id ? 'active' : ''}
              onClick={() => setPrefs({ lang: lang.id })}
            >
              {lang.label}
            </button>
          ))}
        </div>
      </div>

      <div className="console-row">
        <span className="console-label">Favourite club</span>
        <div className="segmented">
          <button
            type="button"
            className={prefs.clubId === null ? 'active' : ''}
            onClick={() => setPrefs({ clubId: null })}
          >
            Neutral
          </button>
          {[match.meta.home, match.meta.away].map((club) => (
            <button
              type="button"
              key={club.id}
              className={prefs.clubId === club.id ? 'active' : ''}
              onClick={() => setPrefs({ clubId: club.id })}
            >
              {club.abbr}
            </button>
          ))}
        </div>
      </div>

      <div className="console-row">
        <span className="console-label">Player focus</span>
        <select
          value={prefs.playerId ?? ''}
          onChange={(event) => setPrefs({ playerId: event.target.value || null })}
        >
          <option value="">Whole match</option>
          {players.map((player) => (
            <option key={player.id} value={player.id}>
              #{player.shirt} {player.name} ({player.team === 'home' ? match.meta.home.abbr : match.meta.away.abbr})
            </option>
          ))}
        </select>
      </div>

      <div className="console-row">
        <span className="console-label">Metric lens</span>
        <div className="segmented wrap">
          {METRICS.map((metric) => (
            <button
              type="button"
              key={metric.id}
              className={(prefs.metric ?? '') === metric.id ? 'active' : ''}
              onClick={() => setPrefs({ metric: metric.id || null })}
            >
              {metric.label}
            </button>
          ))}
        </div>
      </div>

      <div className="console-foot">
        <span className={`provider-chip ${match.providerSummary.recorded ? 'llm' : 'template'}`}>
          {match.providerSummary.recorded ? 'studio voice · recorded' : 'template voice'}
        </span>
        {match.providerSummary.recorded && (
          <span className="provider-note">
            {match.providerSummary.completed} model narrations · {match.providerSummary.fallback} template fallbacks
          </span>
        )}
      </div>
    </section>
  );
}
