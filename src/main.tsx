import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Reactor } from '@reactor-team/js-sdk';
import { API_URL, Session, request } from './session';
import { SessionTimer } from './SessionTimer';
import './style.css';

type Phase = 'idle' | 'joining' | 'waiting' | 'connecting' | 'live' | 'leaving' | 'release-error';
const ideas = [
  { name: 'Into the wild', tag: 'NATURE', prompt: 'A red fox walking through a snowy pine forest at dawn. Soft golden light filters through the trees, snowflakes drift slowly, cinematic tracking shot.' },
  { name: 'After hours', tag: 'CINEMATIC', prompt: 'A quiet Tokyo street at night in the rain. Neon signs reflected in puddles, steam rising from a small ramen shop, slow cinematic dolly forward.' },
  { name: 'Another world', tag: 'IMAGINATION', prompt: 'An astronaut wanders through a field of luminous flowers on an alien planet. Two moons hang above distant mountains, dreamy light, slow sweeping camera.' },
];
function App() {
  const [key, setKey] = useState('');
  const [prompt, setPrompt] = useState(ideas[0].prompt);
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState('Ready when you are');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasVideo, setHasVideo] = useState(false);
  const [sessionTime, setSessionTime] = useState<{ deadline: number | null; limit: number } | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const active = useRef<Session | null>(null);
  const media = useRef<MediaStream | null>(null);
  const commandErrors = useRef(0);
  const monitoring = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const joined = phase !== 'idle';
  const live = phase === 'live';

  async function leave(run = active.current) {
    if (!run) return;
    clearInterval(monitoring.current);
    setSessionTime(null);
    setPhase('leaving'); setStatus('Ending session…');
    try {
      await run.leave();
      if (active.current === run) { active.current = null; setPhase('idle'); setStatus('Ready when you are'); setPaused(false); }
    } catch {
      setPhase('release-error'); setStatus('Release not confirmed');
      setError('Could not confirm session release. Select Leave to retry.');
    } finally {
      if (video.current) video.current.srcObject = null;
      media.current?.getTracks().forEach(track => track.stop());
      media.current = null; setHasVideo(false);
    }
  }
  useEffect(() => {
    const unload = () => { void active.current?.leave().catch(() => {}); };
    window.addEventListener('pagehide', unload);
    return () => { unload(); clearInterval(monitoring.current); window.removeEventListener('pagehide', unload); };
  }, []);

  async function start() {
    if (active.current || !key.trim() || !prompt.trim()) return;
    setError(''); setNotice(''); setPhase('joining'); setStatus('Joining Orbis…');
    setSessionTime(null);
    const run = new Session(); active.current = run;
    const initialErrors = commandErrors.current;
    try {
      await run.start(key.trim(), prompt.trim(), () => {
        const transport = new Reactor({ apiUrl: API_URL, modelName: 'orbis-tpu', local: false });
        const stream = new MediaStream(); media.current = stream;
        transport.on('trackReceived', (_name, track) => {
          if (run.cancelled || !video.current) return;
          if (!stream.getTracks().some(t => t.id === track.id)) stream.addTrack(track);
          if (track.kind === 'video') setHasVideo(true);
          video.current.srcObject = stream;
          void video.current.play().catch(() => setNotice('Press Play in the video player to begin playback.'));
        });
        transport.on('error', () => {
          commandErrors.current++;
          if (!run.cancelled) setError('Orbis reported a stream or command error. Retry the control, or leave and start a new session.');
        });
        transport.on('statusChanged', value => {
          if (!run.cancelled && value === 'disconnected') {
            setError('The stream disconnected. Start a new session to continue.');
            void leave(run);
          }
        });
        return transport;
      }, ticket => {
        // Before connection, expires_in describes the admission window, not stream time.
        setSessionTime({ deadline: null, limit: ticket.session_seconds });
        setPhase(ticket.status === 'waiting' ? 'waiting' : 'connecting');
        setStatus(ticket.status === 'waiting' ? `In queue · position ${ticket.position}` : 'Connecting your stream…');
      });
      if (run.cancelled) return;
      if (commandErrors.current !== initialErrors) { await leave(run); return; }
      setPhase('live'); setStatus('Session connected');
      let checking = false;
      const checkStatus = async () => {
        if (checking || run.cancelled) return;
        checking = true;
        try {
          const ticket = await request('/status', { headers: run.headers });
          if (run.cancelled || active.current !== run) return;
          if (ticket.status !== 'active') { setError('Your session ended. Start again to continue.'); void leave(run); }
          else {
            setSessionTime({
              deadline: ticket.expires_in === null ? null : Date.now() + Math.max(0, ticket.expires_in) * 1000,
              limit: ticket.session_seconds,
            });
          }
        } catch (err) {
          if (!run.cancelled && err instanceof Error && 'status' in err && err.status === 401) { setError('Your session expired. Start again to continue.'); void leave(run); }
        } finally { checking = false; }
      };
      monitoring.current = setInterval(() => void checkStatus(), 15000);
      void checkStatus();
    } catch (err) {
      if (!run.cancelled) setError(err instanceof Error ? err.message : 'Could not start this session.');
      await leave(run);
    }
  }
  async function command(name: string, data: Record<string, unknown>) {
    const run = active.current;
    if (!run?.transport || run.cancelled || busy) return;
    setBusy(true); setError(''); setNotice('');
    const before = commandErrors.current;
    try {
      await run.transport.sendCommand(name, data);
      if (run.cancelled || before !== commandErrors.current) return;
      if (name === 'set_paused') setPaused(Boolean(data.paused));
      setNotice(name === 'set_prompt' ? 'Prompt update sent.' : `${data.paused ? 'Pause' : 'Resume'} request sent.`);
    } catch { setError('The command could not be sent. Please try again.'); }
    finally { setBusy(false); }
  }
  return <div className="app">

    <main>
      <div className="intro"><div><p className="eyebrow">REAL-TIME VIDEO · RUNNING ON TPUs</p><h1>Think it. <em>Watch it unfold.</em></h1><p className="subtitle">Experience live video and audio from Orbis, running on TPUs. Shape the scene as you go.</p></div><span className="version">ORBIS ON TPUs <span>01 / LIVE</span></span></div>
      <div className="workspace">
        <section className="composer" aria-label="Video controls">
          <div className="section-heading"><span className="step">01</span><h2>Set the scene</h2><span className="small-label">YOUR DIRECTION</span></div>
          <label htmlFor="prompt">What do you want to see?</label>
          <textarea id="prompt" value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Describe a place, a character, a little movement…"/>
          <p className="field-hint">Add a subject, atmosphere, and camera movement.</p>
          <div className="ideas-label">A PLACE TO START <span>↙</span></div>
          <div className="ideas">{ideas.map((idea, index) => <button className={`idea idea-${index}`} key={idea.name} onClick={() => setPrompt(idea.prompt)}><span className="idea-art" aria-hidden="true">{['✳', '▥', '✧'][index]}</span><span><small>{idea.tag}</small>{idea.name}</span><span className="idea-arrow">↗</span></button>)}</div>
          <div className="key-field"><label htmlFor="key">Your Orbis API key <span>REQUIRED</span></label><input id="key" type="password" autoComplete="off" spellCheck={false} value={key} disabled={joined} onChange={e => setKey(e.target.value)} placeholder="Enter your API key"/><p className="field-hint">Used only for this session. Never saved in your browser.</p></div>
          {!joined ? <button className="primary" disabled={!key.trim() || !prompt.trim()} onClick={() => void start()}>Start creating <span>↗</span></button> : <div className="session-actions"><button className="primary" disabled={!live || busy || !prompt.trim()} onClick={() => void command('set_prompt', { prompt: prompt.trim() })}>Update scene <span>↗</span></button><button className="secondary" disabled={phase === 'leaving'} onClick={() => void leave()}>{phase === 'waiting' || phase === 'joining' ? 'Cancel' : 'Leave'}</button></div>}
          <p className="bottom-hint">Live video + audio · One continuous session</p>
        </section>
        <section className="stage" aria-label="Live preview">
          <div className="preview-top"><div className="section-heading"><span className="step">02</span><h2>Your canvas</h2></div><span className={`status-pill ${live ? 'is-live' : ''}`}><i/>{live ? 'LIVE SESSION' : phase === 'idle' ? 'STANDBY' : 'CONNECTING'}</span></div>
          <div className={`viewport ${hasVideo ? 'has-video' : ''}`}>
            <video ref={video} autoPlay muted playsInline controls aria-label="Live generated video"/>
            {!hasVideo && <div className="empty-canvas"><div className="orbit" aria-hidden="true"><div/><span>✦</span></div><h3>{joined ? status : 'Every world starts with a few words.'}</h3><p>{joined ? 'Your live video will appear here.' : 'Describe your scene, add your key, and let it unfold.'}</p><span className="canvas-label">IMAGINATION, IN REAL TIME</span></div>}
          </div>
          <div className="player-toolbar"><span className="player-status" role="status"><i className={live ? 'is-live' : ''}/>{status}</span><div>{sessionTime && <SessionTimer deadline={sessionTime.deadline} limit={sessionTime.limit}/>}<button className="text-button" disabled={!live || busy} onClick={() => void command('set_paused', { paused: !paused })}>{paused ? '▷ Resume' : 'Ⅱ Pause'}</button></div></div>
          <div className="stage-footnote"><span>1920 × 1080 <b>·</b> LIVE AUDIO</span><span>Unmute in player</span></div>
          {error && <div className="message error" role="alert">{error}</div>}{notice && <div className="message" role="status">{notice}</div>}
        </section>
      </div>
      <section className="how" id="how-it-works"><p className="eyebrow">FROM AN IDEA TO A MOMENT</p><div><article><span>01 / DESCRIBE</span><h3>Give your world a starting point.</h3><p>Enter your own Orbis API key and a scene. If Orbis is busy, we’ll hold your place in the queue.</p></article><article><span>02 / DIRECT</span><h3>Follow your imagination.</h3><p>Update your prompt as the stream unfolds. New directions blend into the next moments of video.</p></article><article><span>03 / EXPLORE</span><h3>Let the scene unfold.</h3><p>Watch and listen live, or pause to take a break. Select Leave when you’re done to end your session.</p></article></div></section>
    </main><footer><span>◒ orbis studio</span><span>Made for the moments you haven’t imagined yet.</span><span>VIDEO, UNFOLDING.</span></footer>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
