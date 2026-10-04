/** Unified invoke/listen: Tauri IPC on desktop, WebSocket JSON-RPC on the phone PWA. */

type Unlisten = () => void;
type EventCb = (payload: unknown) => void;

const listeners = new Map<string, Set<EventCb>>();

function emitLocal(event: string, payload: unknown) {
  const set = listeners.get(event);
  if (!set) return;
  for (const cb of [...set]) cb(payload);
}

export function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
  return typeof internals?.invoke === 'function';
}

export function isCompanion(): boolean {
  if (typeof window === 'undefined') return false;
  if (isTauri()) return false;
  const path = window.location.pathname;
  if (path === '/m' || path.startsWith('/m/')) return true;
  if (window.location.hash.includes('t=')) return true;
  try {
    return !!(sessionStorage.getItem('grokCompanionToken') || localStorage.getItem('grokCompanionToken'));
  } catch {
    return false;
  }
}

let ws: WebSocket | null = null;
let wsReady: Promise<void> | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let reconnectTimer: number | null = null;
let reconnectAttempt = 0;
let connectGen = 0;

function storedToken(): string {
  try {
    return sessionStorage.getItem('grokCompanionToken') || localStorage.getItem('grokCompanionToken') || '';
  } catch {
    return '';
  }
}

function persistToken(token: string) {
  try {
    sessionStorage.setItem('grokCompanionToken', token);
    localStorage.setItem('grokCompanionToken', token);
  } catch {
    /* private mode */
  }
}

function clearTokenFromAddressBar() {
  try {
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    if (new URLSearchParams(hash).has('t')) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }
  } catch {
    /* History API may be unavailable in an embedded browser. */
  }
}

export function companionTokenFromLocation(): string {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  const fromHash = new URLSearchParams(hash).get('t');
  if (fromHash) return fromHash;
  const fromQuery = new URLSearchParams(window.location.search).get('t');
  return fromQuery || storedToken();
}

function wsUrl(token: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws?t=${encodeURIComponent(token)}`;
}

function handleWsMessage(raw: string) {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  if (typeof data.event === 'string') {
    emitLocal(data.event, data.payload);
    return;
  }
  const id = typeof data.id === 'number' ? data.id : Number(data.id);
  if (!Number.isFinite(id) || !pending.has(id)) return;
  const slot = pending.get(id)!;
  pending.delete(id);
  if (data.ok) slot.resolve(data.result);
  else slot.reject(new Error(String(data.error || '请求失败')));
}

function scheduleReconnect(token: string) {
  if (reconnectTimer != null) return;
  reconnectAttempt += 1;
  const delay = Math.min(8000, 1000 * 2 ** Math.min(reconnectAttempt, 3));
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    void openWs(token);
  }, delay);
}

function openWs(token: string): Promise<void> {
  const gen = ++connectGen;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return wsReady || Promise.resolve();
  }
  persistToken(token);
  clearTokenFromAddressBar();
  wsReady = new Promise((resolve, reject) => {
    const sock = new WebSocket(wsUrl(token));
    ws = sock;
    sock.onopen = () => {
      if (gen !== connectGen) return;
      reconnectAttempt = 0;
      emitLocal('companion-connection', { status: 'open' });
      resolve();
    };
    sock.onerror = () => {
      if (gen !== connectGen) return;
      emitLocal('companion-connection', { status: 'error' });
      reject(new Error('无法连接电脑端'));
    };
    sock.onclose = () => {
      if (gen !== connectGen) return;
      ws = null;
      wsReady = null;
      for (const [id, slot] of pending) {
        slot.reject(new Error('电脑端连接已断开'));
        pending.delete(id);
      }
      emitLocal('companion-connection', { status: 'closed' });
      scheduleReconnect(token);
    };
    sock.onmessage = (ev) => {
      if (typeof ev.data === 'string') handleWsMessage(ev.data);
    };
  });
  return wsReady;
}

export function connectCompanion(token = companionTokenFromLocation()): Promise<void> {
  if (!token) return Promise.reject(new Error('缺少配对令牌，请重新扫描电脑上的二维码'));
  return openWs(token);
}

export function disconnectCompanion() {
  connectGen += 1;
  if (reconnectTimer != null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  ws?.close();
  ws = null;
  wsReady = null;
}

async function invokeWs(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    await connectCompanion();
  }
  const sock = ws;
  if (!sock || sock.readyState !== WebSocket.OPEN) {
    throw new Error('电脑端未连接');
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    sock.send(JSON.stringify({ id, cmd, args: args || {} }));
  });
}

export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) {
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
    return tauriInvoke<T>(cmd, args);
  }
  return invokeWs(cmd, args) as Promise<T>;
}

export async function listen<T = unknown>(event: string, cb: (payload: T) => void): Promise<Unlisten> {
  if (isTauri()) {
    const { listen: tauriListen } = await import('@tauri-apps/api/event');
    const un = await tauriListen<T>(event, (ev) => cb(ev.payload));
    return () => {
      void un();
    };
  }
  const wrapped: EventCb = (payload) => cb(payload as T);
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(wrapped);
  return () => {
    listeners.get(event)?.delete(wrapped);
  };
}
