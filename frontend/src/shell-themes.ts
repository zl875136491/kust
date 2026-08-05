import type { ITheme } from '@xterm/xterm';
import type { ShellTheme, ThemeMode } from './types';

interface ShellThemePalette extends ITheme {
  background: string;
  foreground: string;
  cursor: string;
}

export interface ShellThemeOption {
  value: ShellTheme;
  label: string;
  description: string;
  preview: Pick<ShellThemePalette, 'background' | 'foreground' | 'cursor'>;
}

const systemLight: ShellThemePalette = {
  background: '#f7faf8', foreground: '#1d2923', cursor: '#08764b', cursorAccent: '#f7faf8',
  selectionBackground: '#bfe8d3', black: '#202824', red: '#b4232d', green: '#08764b', yellow: '#8a6510',
  blue: '#1467a8', magenta: '#8a3ea0', cyan: '#007b83', white: '#dce5e0', brightBlack: '#66726c',
  brightRed: '#d13b45', brightGreen: '#15945f', brightYellow: '#a77a10', brightBlue: '#237fc4',
  brightMagenta: '#a654ba', brightCyan: '#0797a0', brightWhite: '#ffffff',
};

const systemDark: ShellThemePalette = {
  background: '#0b1013', foreground: '#e4ece8', cursor: '#55e7a1', cursorAccent: '#0b1013',
  selectionBackground: '#275944', black: '#101719', red: '#f16d78', green: '#55e7a1', yellow: '#e4c26d',
  blue: '#70a9ff', magenta: '#d38cf2', cyan: '#64d9e2', white: '#d6dfdb', brightBlack: '#65736d',
  brightRed: '#ff8d96', brightGreen: '#7bf0b7', brightYellow: '#f3d788', brightBlue: '#92bdff',
  brightMagenta: '#e4a6fa', brightCyan: '#86e9ef', brightWhite: '#ffffff',
};

const palettes: Record<Exclude<ShellTheme, 'system' | 'light' | 'dark'>, ShellThemePalette> = {
  'one-dark': {
    background: '#282c34', foreground: '#abb2bf', cursor: '#528bff', cursorAccent: '#282c34', selectionBackground: '#3e4451',
    black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
    brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff',
  },
  dracula: {
    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36', selectionBackground: '#44475a',
    black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
  },
  'solarized-dark': {
    background: '#002b36', foreground: '#839496', cursor: '#93a1a1', cursorAccent: '#002b36', selectionBackground: '#073642',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
  nord: {
    background: '#2e3440', foreground: '#d8dee9', cursor: '#88c0d0', cursorAccent: '#2e3440', selectionBackground: '#434c5e',
    black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
    brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
  },
  'gruvbox-dark': {
    background: '#282828', foreground: '#ebdbb2', cursor: '#fabd2f', cursorAccent: '#282828', selectionBackground: '#504945',
    black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
    brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
  },
  'tokyo-night': {
    background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', cursorAccent: '#1a1b26', selectionBackground: '#33467c',
    black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
    brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
  },
};

export const shellThemeOptions: ShellThemeOption[] = [
  { value: 'system', label: '跟随系统', description: '随网站明暗模式切换', preview: systemDark },
  { value: 'light', label: '系统浅色', description: '清晰的浅色终端', preview: systemLight },
  { value: 'dark', label: '系统深色', description: 'Kust 默认深色终端', preview: systemDark },
  ...([
    ['one-dark', 'One Dark', 'Atom 经典配色'],
    ['dracula', 'Dracula', '高对比紫色系'],
    ['solarized-dark', 'Solarized Dark', '低对比护眼配色'],
    ['nord', 'Nord', '冷色极地配色'],
    ['gruvbox-dark', 'Gruvbox Dark', '复古暖色配色'],
    ['tokyo-night', 'Tokyo Night', '现代蓝紫配色'],
  ] as const).map(([value, label, description]) => ({ value, label, description, preview: palettes[value] })),
];

export function resolveShellTheme(theme: ShellTheme, websiteTheme: ThemeMode | 'light' | 'dark'): ShellThemePalette {
  const resolved = theme === 'system' ? (websiteTheme === 'light' ? systemLight : systemDark)
    : theme === 'light' ? systemLight
      : theme === 'dark' ? systemDark
        : palettes[theme];
  return { ...resolved };
}
