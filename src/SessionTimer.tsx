import { useEffect, useState } from 'react';

export function SessionTimer({ deadline, limit }: { deadline: number | null; limit: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (deadline === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  const remaining = deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000));
  const seconds = remaining ?? Math.ceil(limit);
  const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return <span
    className={`session-timer ${remaining !== null && remaining <= 60 ? 'ending-soon' : ''}`}
    role="timer"
    aria-live="off"
    title="Session time keeps running while paused. Remaining time is refreshed from Orbis."
  >{duration} <span>{remaining === null ? 'session limit' : 'remaining'}</span></span>;
}
