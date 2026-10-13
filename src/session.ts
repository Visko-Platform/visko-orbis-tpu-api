export const START_FAILURE_MESSAGE = 'Generation failed to start. Please try again later.';
export function isStartFailure(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  let message = raw as Record<string, unknown>;
  if (message.scope === 'application' && message.data && typeof message.data === 'object') {
    message = message.data as Record<string, unknown>;
  }
  if (message.type !== 'command_error') return false;
  const detail = message.data && typeof message.data === 'object' ? message.data as Record<string, unknown> : message;
  return detail.command === 'start';
}

export const API_URL = 'https://orbis-stable-tpu.visko.ai';
export interface Ticket { session_token: string; status: 'waiting' | 'active' | 'releasing'; position: number; expires_in: number | null; session_seconds: number }
export class ApiError extends Error {
  constructor(public status: number) {
    super(({401: 'Your key or session is invalid or expired.', 429: 'The queue is full. Please try again later.', 503: 'Orbis is unavailable. Please try again shortly.'} as Record<number, string>)[status] ?? `Orbis request failed (${status}).`);
  }
}
export async function request(path: string, options: RequestInit = {}): Promise<Ticket> {
  const response = await fetch(`${API_URL}${path}`, options);
  if (!response.ok) throw new ApiError(response.status);
  return response.json();
}
export interface Transport { connect(token: string): Promise<void>; disconnect(): Promise<void>; sendCommand(command: string, data: Record<string, unknown>): Promise<unknown> }
export class Session {
  token = '';
  cancelled = false;
  startFailed = false;
  transport?: Transport;
  joining?: Promise<Ticket>;
  connecting?: Promise<void>;
  closing?: Promise<void>;
  constructor(private http = request, private wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))) {}
  async start(key: string, prompt: string, create: () => Transport, status: (ticket: Ticket) => void) {
    this.joining = this.http('/join', { method: 'POST', headers: { 'X-Orbis-API-Key': key } }).then(ticket => {
      if (!ticket.session_token) throw new Error('Orbis did not return a session token.');
      this.token = ticket.session_token;
      return ticket;
    });
    let ticket = await this.joining;
    while (!this.cancelled && ticket.status === 'waiting') {
      status(ticket);
      await this.wait(1500);
      if (!this.cancelled) ticket = await this.http('/status', { headers: this.headers });
    }
    if (this.cancelled) return;
    if (ticket.status !== 'active') throw new Error('This session is being released. Leave and try again.');
    status(ticket);
    this.transport = create();
    this.connecting = this.transport.connect(this.token);
    await this.connecting;
    if (!this.cancelled) await this.transport.sendCommand('start', { prompt });
  }
  get headers() { return { Authorization: `Bearer ${this.token}` }; }
  leave(): Promise<void> {
    if (this.closing) return this.closing;
    this.cancelled = true;
    this.closing = this.release().catch(error => { this.closing = undefined; throw error; });
    return this.closing;
  }
  private async release() {
    await this.joining?.catch(() => {});
    try {
      if (this.token) {
        for (let attempt = 0; ; attempt++) {
          try { await this.http('/leave', { method: 'POST', headers: this.headers, keepalive: true }); break; }
          catch (error) {
            if (error instanceof ApiError && error.status === 401) break;
            if (attempt === 2) throw error;
            await this.wait(500 * (attempt + 1));
          }
        }
      }
    } finally {
      await this.connecting?.catch(() => {});
      await this.transport?.disconnect().catch(() => {});
    }
  }
}
