import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import reducer, { toggleNav, setNavCollapsed, storedNavCollapsed, storedMode, storedLang } from '../src/store/uiSlice';

/* The collapsed state is read straight out of localStorage at boot, so it has to normalise like
 * mode and lang do: anything other than the exact stored token means "expanded". */

const initial = () => reducer(undefined, { type: '@@INIT' });

describe('sidebar collapse state', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('starts expanded when nothing has been stored', () => {
    expect(initial().navCollapsed).toBe(false);
  });

  it('toggles and persists in both directions', () => {
    let s = initial();
    s = reducer(s, toggleNav());
    expect(s.navCollapsed).toBe(true);
    expect(localStorage.getItem('maritime-nav')).toBe('collapsed');
    s = reducer(s, toggleNav());
    expect(s.navCollapsed).toBe(false);
    expect(localStorage.getItem('maritime-nav')).toBe('expanded');
  });

  it('sets an explicit value without reading the previous one', () => {
    let s = reducer(initial(), setNavCollapsed(true));
    expect(s.navCollapsed).toBe(true);
    s = reducer(s, setNavCollapsed(true));
    expect(s.navCollapsed).toBe(true);
  });

  it('treats any unrecognised stored value as expanded rather than passing it on', () => {
    // localStorage is keyed by origin, so a key left by another build can hold anything at all.
    for (const junk of ['true', '1', 'yes', '{"a":1}', '']) {
      localStorage.setItem('maritime-nav', junk);
      expect(storedNavCollapsed(), junk).toBe(false);
    }
    localStorage.setItem('maritime-nav', 'collapsed');
    expect(storedNavCollapsed()).toBe(true);
  });

  it('normalises the other stored preferences the same way', () => {
    localStorage.setItem('maritime-mode', 'DARK');   // wrong case is not 'dark'
    localStorage.setItem('maritime-lang', 'fr');     // a language the app does not carry
    expect(storedMode()).toBe('light');
    expect(storedLang()).toBe('en');
  });

  it('survives storage being unavailable', () => {
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error('denied'); };
    try {
      expect(storedNavCollapsed()).toBe(false);
      expect(storedMode()).toBe('light');
    } finally { Storage.prototype.getItem = get; }
  });
});
