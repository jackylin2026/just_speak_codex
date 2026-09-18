import { createRoot } from 'react-dom/client';

import { RecBar } from './RecBar';
import './styles.css';

// The rec bar holds a microphone, a socket and a recording in long-lived refs, and hot
// module replacement patches the component without re-running any of it: measured, a
// change to the recorder simply did not take effect, and the page kept reporting numbers
// from the previous build. Reload instead — it is a rec bar, not a document to preserve.
if (import.meta.hot) import.meta.hot.on('vite:beforeUpdate', () => window.location.reload());

const root = document.getElementById('root');
if (!root) throw new Error('The page has no root element.');

createRoot(root).render(<RecBar />);
