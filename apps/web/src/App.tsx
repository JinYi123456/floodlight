import { useAppStore } from './state/store';
import { Launch } from './ui/Launch';
import { Preparing } from './ui/Preparing';
import { ControlRoom } from './ui/ControlRoom';

export function App() {
  const phase = useAppStore((state) => state.phase);
  const error = useAppStore((state) => state.error);
  const backToLaunch = useAppStore((state) => state.backToLaunch);

  if (phase === 'preparing') return <Preparing />;
  if (phase === 'ready') return <ControlRoom />;
  return (
    <>
      <Launch />
      {phase === 'error' && (
        <div className="error-toast" role="alert">
          <strong>The pipeline hit a problem.</strong>
          <span>{error}</span>
          <button type="button" onClick={backToLaunch}>
            Back
          </button>
        </div>
      )}
    </>
  );
}
