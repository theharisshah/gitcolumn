import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './styles/files.css';
import './styles/reflog.css';
import './styles/workingcopy.css';

if (window.gitcolumn) document.documentElement.classList.add('electron', `platform-${window.gitcolumn.platform}`);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
