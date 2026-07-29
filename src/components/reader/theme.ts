import type { HighlightColor, ReaderFontId, ReaderThemeId } from '../../utils/readerStore';

export interface ReaderTheme {
  id: ReaderThemeId;
  label: string;
  /** Area around the page. */
  canvas: string;
  /** The page itself. */
  page: string;
  text: string;
  muted: string;
  rule: string;
  chrome: string;
  chromeText: string;
  accent: string;
  swatch: string;
  selection: string;
}

export const READER_THEMES: Record<ReaderThemeId, ReaderTheme> = {
  paper: {
    id: 'paper',
    label: 'Paper',
    canvas: '#E9E5DC',
    page: '#FAF8F3',
    text: '#1F1D1A',
    muted: '#7A736A',
    rule: '#DED8CC',
    chrome: '#FFFFFF',
    chromeText: '#3B3730',
    accent: '#9A7B21',
    swatch: '#FAF8F3',
    selection: 'rgba(212,175,55,0.28)',
  },
  sepia: {
    id: 'sepia',
    label: 'Sepia',
    canvas: '#E4D8BE',
    page: '#F6EDD8',
    text: '#4A3A28',
    muted: '#8B7654',
    rule: '#DFD0AE',
    chrome: '#F9F2E2',
    chromeText: '#5B4636',
    accent: '#8A6A1F',
    swatch: '#F6EDD8',
    selection: 'rgba(138,106,31,0.24)',
  },
  night: {
    id: 'night',
    label: 'Night',
    canvas: '#141416',
    page: '#1C1C1F',
    text: '#D6D3CD',
    muted: '#8A8783',
    rule: '#2E2E33',
    chrome: '#232327',
    chromeText: '#D6D3CD',
    accent: '#D4AF37',
    swatch: '#1C1C1F',
    selection: 'rgba(212,175,55,0.26)',
  },
  black: {
    id: 'black',
    label: 'Black',
    canvas: '#000000',
    page: '#000000',
    text: '#BFBDB8',
    muted: '#767470',
    rule: '#1E1E20',
    chrome: '#0B0B0C',
    chromeText: '#BFBDB8',
    accent: '#D4AF37',
    swatch: '#000000',
    selection: 'rgba(212,175,55,0.24)',
  },
};

export const READER_FONTS: Record<ReaderFontId, { label: string; stack: string; scale: number }> = {
  serif: {
    label: 'Bookerly',
    stack: "Georgia, 'Iowan Old Style', 'Palatino Linotype', 'Times New Roman', serif",
    scale: 1,
  },
  literary: {
    label: 'Literata',
    stack: "'Lora', 'Charter', 'Bitstream Charter', Georgia, serif",
    scale: 1,
  },
  sans: {
    label: 'Helvetica',
    stack: "'Inter', system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
    scale: 0.96,
  },
  mono: {
    label: 'Mono',
    stack: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
    scale: 0.9,
  },
};

export const HIGHLIGHT_COLORS: Record<HighlightColor, { label: string; light: string; dark: string; dot: string }> = {
  yellow: { label: 'Yellow', light: 'rgba(255, 214, 82, 0.45)', dark: 'rgba(212, 175, 55, 0.32)', dot: '#E8C348' },
  mint: { label: 'Mint', light: 'rgba(115, 220, 160, 0.40)', dark: 'rgba(46, 160, 105, 0.34)', dot: '#4FBF88' },
  sky: { label: 'Sky', light: 'rgba(130, 190, 255, 0.42)', dark: 'rgba(64, 132, 214, 0.36)', dot: '#5FA3E8' },
  rose: { label: 'Rose', light: 'rgba(255, 150, 175, 0.40)', dark: 'rgba(203, 89, 122, 0.34)', dot: '#E4738F' },
};

export function isDarkTheme(theme: ReaderThemeId): boolean {
  return theme === 'night' || theme === 'black';
}

export function highlightFill(color: HighlightColor, theme: ReaderThemeId): string {
  return isDarkTheme(theme) ? HIGHLIGHT_COLORS[color].dark : HIGHLIGHT_COLORS[color].light;
}
