export type Tone = 'red' | 'green' | 'orange' | 'blue' | 'purple' | 'yellow' | 'teal' | 'pink';

export interface Tool {
  id: string;
  label: string;
  /** SVG path data on a 24x24 grid, drawn as a stroke. */
  d: string;
  /** Optional accent colour for the icon. */
  tone?: Tone;
}

export interface ToolPage {
  name: string;
  items: Tool[];
}

const t = (id: string, label: string, d: string, tone?: Tone): Tool => ({ id, label, d, tone });

export const PAGES: ToolPage[] = [
  {
    name: 'Quick',
    items: [
      t('capture', 'Capture', 'M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M9 9h6v6H9z', 'blue'),
      t('record', 'Record', 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 9a3 3 0 100 6 3 3 0 000-6z', 'red'),
      t('draw', 'Draw', 'M4 20l3.5-1L19 7.5 16.500 5 5 16.500zM14 7.500l2.500 2.500M4 20h16', 'orange'),
      t('clips', 'Clips', 'M8 5H6v16h12V5h-2M9 3h6v4H9zM9 12h6M9 16h4', 'teal'),
      t('notes', 'Notes', 'M5 4h14v10l-5 6H5zM14 20v-6h5', 'yellow'),
      t('voice', 'Voice', 'M9 6a3 3 0 016 0v5a3 3 0 01-6 0zM6 11a6 6 0 0012 0M12 17v4', 'green'),
      t('ai', 'Ask AI', 'M12 4l1.8 5.2L19 11l-5.2 1.8L12 18l-1.8-5.2L5 11l5.2-1.8z', 'purple'),
      t('phone', 'Phone', 'M7 3h10v18H7zM11 18h2', 'blue'),
      t('vault', 'Vault', 'M6 11h12v9H6zM8 11V8a4 4 0 018 0v3M12 14v3', 'pink'),
    ],
  },
  {
    name: 'Files',
    items: [
      t('pdf', 'PDF', 'M7 3h7l4 4v14H7zM14 3v4h4', 'red'),
      t('image', 'Image', 'M3 5h18v14H3zM4 18l5-5 4 4 3-3 4 4M8 9h1', 'green'),
      t('video', 'Video', 'M3 6h13v12H3zM16 10l5-3v10l-5-3', 'purple'),
      t('audio', 'Audio', 'M9 18V6l10-2v12M9 18a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zM19 16a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z', 'pink'),
      t('zip', 'Zip', 'M4 4h16v4H4zM5 8v12h14V8M10 12h4', 'yellow'),
      t('cutbg', 'Cut BG', 'M5 19L16 8M14 6l4 4M18 3v3M16.5 4.5h3M7 5v2M6 6h2', 'teal'),
      t('rename', 'Rename', 'M4 20h4l10-10-4-4L4 16zM13 7l4 4', 'orange'),
      t('ocr', 'OCR', 'M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M8 10h8M8 14h5', 'green'),
    ],
  },
  {
    name: 'System',
    items: [
      t('wifi', 'Wi-Fi', 'M3 9a14 14 0 0118 0M6 12.5a9 9 0 0112 0M9 16a4.5 4.5 0 016 0M12 19h.01', 'blue'),
      t('bt', 'Bluetooth', 'M7 8l10 8-5 4V4l5 4-10 8', 'blue'),
      t('mute', 'Mute', 'M9 6a3 3 0 016 0v5a3 3 0 01-6 0zM6 11a6 6 0 0012 0M12 17v4M4 4l16 16', 'red'),
      t('night', 'Night', 'M20 14A8 8 0 0110 4a8 8 0 1010 10z', 'purple'),
      t('awake', 'Awake', 'M5 9h11v5a5 5 0 01-5 5h-1a5 5 0 01-5-5zM16 10h2a2 2 0 010 5h-2M8 3v3M12 3v3', 'yellow'),
      t('mixer', 'Mixer', 'M6 4v16M12 4v16M18 4v16M4 9h4M10 15h4M16 8h4', 'green'),
      t('output', 'Output', 'M4 14v-2a8 8 0 0116 0v2M4 14h3v6H4zM17 14h3v6h-3z', 'teal'),
      t('bright', 'Bright', 'M12 8a4 4 0 100 8 4 4 0 000-8zM12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4', 'orange'),
      t('lock', 'Lock PC', 'M4 5h16v11H4zM9 20h6M12 16v4', 'pink'),
    ],
  },
  {
    name: 'More',
    items: [
      t('convert', 'Convert', 'M4 8h14l-3-3M20 16H6l3 3', 'green'),
      t('shelf', 'Shelf', 'M4 13l3-8h10l3 8v6H4zM4 13h5l1 2h4l1-2h5', 'blue'),
      t('timer', 'Timer', 'M12 5a8 8 0 100 16 8 8 0 000-16zM12 9v4l2.5 2M9 2h6', 'orange'),
      t('clocks', 'Clocks', 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 8v4l3 2M4 12h1M19 12h1', 'teal'),
      t('calendar', 'Calendar', 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4', 'red'),
      t('colour', 'Colour', 'M12 3l6 8a6 6 0 11-12 0z', 'pink'),
      t('qr', 'QR', 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM18 14h2M14 18h2', 'yellow'),
      t('translate', 'Translate', 'M4 6h8M8 4v2M6 6c0 4 3 6 6 7M11 6c-1 4-3 6-6 7M13 20l4-9 4 9M14.5 17h5', 'blue'),
      t('share', 'Share', 'M12 15V4M8 8l4-4 4 4M5 13v6h14v-6', 'green'),
      t('settings', 'Settings', 'M12 9a3 3 0 100 6 3 3 0 000-6zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1'),
    ],
  },
];
