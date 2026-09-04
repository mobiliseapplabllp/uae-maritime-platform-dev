import { createTheme, type Theme } from '@mui/material/styles';
import type { Mode } from './store/uiSlice';

const heading = { fontFamily: '"Archivo","Public Sans",system-ui,sans-serif', fontWeight: 700, letterSpacing: '-0.015em' };

export const buildTheme = (mode: Mode, direction: 'ltr' | 'rtl' = 'ltr'): Theme => {
  const dark = mode === 'dark';
  const ink = dark ? '#E9F0F0' : '#0B1F2A';
  const paper = dark ? '#0C2330' : '#FFFFFF';
  return createTheme({
    direction,
    palette: {
      mode,
      // Platform accent: #0B74B0 blue -> #75479C purple -> #BD3861 magenta
      primary: { main: dark ? '#57B0E3' : '#0B74B0', dark: dark ? '#7CC4EC' : '#085A8A', contrastText: dark ? '#06181F' : '#FFFFFF' },
      secondary: { main: dark ? '#A87FD1' : '#75479C' },
      success: { main: dark ? '#5FC191' : '#2C6E52' },
      warning: { main: dark ? '#E0A64E' : '#8A5810' },
      error: { main: dark ? '#E4736A' : '#A33229' },
      info: { main: dark ? '#7FA6E0' : '#3B6FB6' },
      background: { default: dark ? '#071620' : '#F1F4F3', paper },
      text: { primary: ink, secondary: dark ? '#AAC1C7' : '#3E5561' },
      divider: dark ? '#1C3F4F' : '#D8E2E2',
    },
    typography: {
      fontFamily: '"Public Sans",system-ui,-apple-system,"Segoe UI",sans-serif',
      h1: heading, h2: heading, h3: heading, h4: heading,
      h5: { ...heading, fontSize: '1.35rem' }, h6: { ...heading, fontSize: '1.05rem' },
      subtitle2: { fontWeight: 600 },
      button: { textTransform: 'none', fontWeight: 600 },
      caption: { color: dark ? '#89A5B0' : '#4A6070' },
    },
    shape: { borderRadius: 10 },
    components: {
      MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
      MuiCard: { defaultProps: { elevation: 0 }, styleOverrides: { root: { border: `1px solid ${dark ? '#1C3F4F' : '#D8E2E2'}` } } },
      MuiTableCell: {
        styleOverrides: {
          root: { borderColor: dark ? '#152F3D' : '#E4EAE9' },
          head: { fontFamily: '"IBM Plex Mono",monospace', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 600, color: dark ? '#89A5B0' : '#4A6070', whiteSpace: 'nowrap', backgroundColor: dark ? '#102D3B' : '#EEF2F1' },
        },
      },
      MuiChip: { styleOverrides: { root: { fontWeight: 600 } } },
      MuiButton: { defaultProps: { disableElevation: true } },
      MuiTooltip: { defaultProps: { arrow: true } },
      MuiTextField: { defaultProps: { size: 'small' } },
      // A table that scrolls has to be reachable by keyboard, or its rows are readable only with a mouse
      // (WCAG 2.1.1). Set here rather than at each of the two dozen call sites, so the next table inherits it.
      MuiTableContainer: { defaultProps: { tabIndex: 0 } },
      MuiFormControl: { defaultProps: { size: 'small' } },
    },
  });
};

// Validated categorical palettes. Fixed order: container, dryBulk, liquid, other — never cycled, never re-ranked.
export const CHART_SERIES = {
  light: { container: '#056A73', dryBulk: '#B98A2F', liquid: '#3B6FB6', other: '#C14F33' },
  dark: { container: '#2FA6AE', dryBulk: '#B8892B', liquid: '#5E88CE', other: '#D0644A' },
} as const;
export type SeriesKey = keyof typeof CHART_SERIES.light;
export const SERIES_ORDER: SeriesKey[] = ['container', 'dryBulk', 'liquid', 'other'];
export const SERIES_LABELS: Record<SeriesKey, string> = { container: 'Container', dryBulk: 'Dry bulk', liquid: 'Liquid', other: 'Other' };
/**
 * The platform's accent colours, and the rule about them.
 *
 * Every one of these is used two ways: as an icon or a chart fill, where nothing is read off it, and as the
 * background of a chip, an avatar or a timeline block, where white text sits on top. The second use has to
 * clear 4.5:1 (WCAG 1.4.3). The teal did not — it was #056A73, which gives 3.51 against white — so it is
 * darkened here rather than in the eight places that use it, and every other accent already clears.
 */
export const ACCENT = {
  teal: '#056A73', blue: '#0B74B0', slate: '#5A6B78', purple: '#75479C',
  green: '#2C6E52', rust: '#B3452E', amber: '#9C6412', magenta: '#BD3861',
} as const;

export const BRAND_GRADIENT = 'linear-gradient(100deg,#0B74B0 0%,#75479C 55%,#BD3861 100%)';
export const BRAND = { blue: '#0B74B0', purple: '#75479C', magenta: '#BD3861', navy: '#0A2239' } as const;
export const MONO = '"IBM Plex Mono",monospace';
/** Chart chrome for the current mode (axis ticks, gridlines, tooltip surface). */
export const chartChrome = (mode: Mode) => {
  const dark = mode === 'dark';
  const grid = dark ? '#152F3D' : '#E4EAE9';
  const paper = dark ? '#0C2330' : '#FFFFFF';
  return { axis: dark ? '#89A5B0' : '#6B838E', grid, paper, tooltipStyle: { backgroundColor: paper, border: `1px solid ${grid}`, borderRadius: 8, fontSize: 12, fontFamily: '"Public Sans",sans-serif' }, cursorFill: dark ? 'rgba(255,255,255,0.04)' : 'rgba(11,31,42,0.04)' };
};
