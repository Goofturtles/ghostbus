import React from 'react';
import { createRoot } from 'react-dom/client';
import './i18n';
import './styles/tokens.css';
import './styles/global.css';
import './styles/app.css';
import { initClientState } from './store';
import { registerServiceWorker } from './pwa';
import App from './App';

initClientState();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

registerServiceWorker();
