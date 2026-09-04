import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ErrorBoundary from '../src/components/common/ErrorBoundary';

const Boom = ({ go }: { go: boolean }) => { if (go) throw new TypeError("Cannot read properties of undefined (reading 'name')"); return <p>the real page</p>; };

describe('ErrorBoundary', () => {
  // React logs caught errors to the console by design; silence it so the run stays readable
  let err: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { err = vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { err.mockRestore(); localStorage.clear(); });

  it('renders its children when nothing throws', () => {
    render(<ErrorBoundary><Boom go={false} /></ErrorBoundary>);
    expect(screen.getByText('the real page')).toBeInTheDocument();
  });

  it('shows the error instead of an empty page when a child throws', () => {
    render(<ErrorBoundary><Boom go /></ErrorBoundary>);
    expect(screen.getByText('This page stopped responding')).toBeInTheDocument();
    // the message itself must reach the screen — a boundary that hides it is no better than a white screen
    expect(screen.getByText(/Cannot read properties of undefined/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clear local data/i })).toBeInTheDocument();
  });

  it('clears the stored session so a poisoned session cannot survive the reload', () => {
    localStorage.setItem('maritime-session', '{"user":{"stale":true}}');
    localStorage.setItem('maritime-mode', 'dark');
    render(<ErrorBoundary><Boom go /></ErrorBoundary>);
    fireEvent.click(screen.getByRole('button', { name: /clear local data/i }));
    expect(localStorage.getItem('maritime-session')).toBeNull();
    expect(localStorage.getItem('maritime-mode')).toBeNull();
  });
});
