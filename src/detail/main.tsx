import { createRoot } from 'react-dom/client';

import { DetailBox } from './DetailBox';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('The page has no root element.');

createRoot(root).render(<DetailBox />);
