import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './styles.css';
import { App } from './App';
import { Stickies } from './Stickies';
import { Draw } from './Draw';
import { Stage } from './Stage';
import { Snip } from './Snip';

// One bundle, three windows: the island, the sticky notes, and the drawing sheet.
const view = new URLSearchParams(location.search).get('view');
const root = createRoot(document.getElementById('root')!);
root.render(view === 'stickies' ? <Stickies /> : view === 'draw' ? <Draw /> : view === 'stage' ? <Stage /> : view === 'snip' ? <Snip /> : <App />);
