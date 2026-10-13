import { useAppStore } from '../state/store';

const STAGE_ORDER = [
  'Playing the match',
  'Interpreting events',
  'Tracking the players',
  'Directing the show',
  'Compiling the cue sheet',
  'Ready',
];

export function Preparing() {
  const label = useAppStore((state) => state.progressLabel);
  const fraction = useAppStore((state) => state.progressFraction);

  const currentIndex = Math.max(0, STAGE_ORDER.findIndex((s) => s === label));

  return (
    <div className="preparing">
      <div className="preparing-inner">
        <div className="wordmark small">
          <span className="wordmark-lamp" aria-hidden />
          <h1>
            FLOOD<span>LIGHT</span>
          </h1>
        </div>
        <p className="preparing-label">{label || 'Warming up'}</p>
        <div className="progress-track" role="progressbar" aria-valuenow={Math.round(fraction * 100)}>
          <div className="progress-fill" style={{ width: `${Math.round(fraction * 100)}%` }} />
        </div>
        <ol className="stage-list">
          {STAGE_ORDER.slice(0, -1).map((stage, index) => (
            <li
              key={stage}
              className={index < currentIndex ? 'done' : index === currentIndex ? 'active' : 'todo'}
            >
              <span className="stage-dot" />
              {stage}
            </li>
          ))}
        </ol>
        <p className="preparing-note">
          Ninety minutes are being played, interpreted and directed in your browser. This runs once per match — the
          playback afterwards is instant.
        </p>
      </div>
    </div>
  );
}
