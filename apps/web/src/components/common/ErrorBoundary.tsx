import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react';

/* Deliberately plain: no MUI, no theme, no i18n, no store. A boundary that renders through the
 * same machinery that just failed can fail with it, and the user is back to a white screen. Inline
 * styles and raw elements are the only things guaranteed to still work here. */

interface Props { children: ReactNode }
interface State { error: Error | null; stack: string }

const KEYS = ['maritime-session', 'maritime-mode', 'maritime-lang', 'maritime-recents', 'berth-view'];

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: '' };

  static getDerivedStateFromError(error: Error): Partial<State> { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ stack: info.componentStack || '' });
    // keep it in the console too, so the browser's own stack mapping is available
    console.error('Unhandled render error:', error, info.componentStack);
  }

  private reset = () => { this.setState({ error: null, stack: '' }); };

  /* The most common cause of a crash that survives a reload is a stored session or preference left
   * behind by an older build — localStorage is shared by origin, so anything previously served on
   * this port wrote into the same bucket. */
  private clearAndReload = () => {
    try { for (const k of KEYS) localStorage.removeItem(k); sessionStorage.clear(); } catch { /* nothing else to try */ }
    window.location.href = '/login';
  };

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;

    const detail = `${error.name}: ${error.message}\n\n${error.stack || ''}\n\nComponent stack:${stack}`;
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: '#f4f6f8', fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', color: '#0a2239' }}>
        <div style={{ maxWidth: 760, width: '100%', background: '#fff', border: '1px solid #d9e2ea', borderRadius: 10, padding: '28px 32px', boxShadow: '0 1px 3px rgba(10,34,57,.08)' }}>
          <h1 style={{ margin: '0 0 6px', fontSize: 19, fontWeight: 600 }}>This page stopped responding</h1>
          <p style={{ margin: '0 0 20px', fontSize: 14, lineHeight: 1.55, color: '#5a6b78' }}>
            Something in the interface threw an error, so it was unmounted rather than left half-drawn.
            The details below are what to send on if this keeps happening.
          </p>

          <pre style={{ margin: '0 0 20px', padding: '14px 16px', background: '#0a2239', color: '#e6eef5', borderRadius: 8, fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 280, overflow: 'auto' }}>{detail}</pre>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button onClick={this.reset} style={btn('#0b74b0', '#fff')}>Try again</button>
            <button onClick={() => window.location.reload()} style={btn('#fff', '#0a2239', '#d9e2ea')}>Reload the page</button>
            <button onClick={this.clearAndReload} style={btn('#fff', '#0a2239', '#d9e2ea')}>Clear local data and sign in again</button>
            <button onClick={() => { void navigator.clipboard?.writeText(detail); }} style={btn('#fff', '#0a2239', '#d9e2ea')}>Copy details</button>
          </div>

          <p style={{ margin: '18px 0 0', fontSize: 12.5, color: '#5a6b78' }}>
            If it returns straight after signing in, try <strong>Clear local data</strong> first — a session
            stored by an earlier build is the usual cause.
          </p>
        </div>
      </div>
    );
  }
}

const btn = (bg: string, fg: string, border?: string): CSSProperties => ({
  background: bg, color: fg, border: `1px solid ${border || bg}`, borderRadius: 7,
  padding: '9px 15px', fontSize: 13.5, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
});
