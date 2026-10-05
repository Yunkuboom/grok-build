import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import MobileApp from './mobile/App';
import { invoke, isCompanion, isTauri } from './bridge';
import { applyLocalePref } from './i18n';
import './styles.css';
import './mobile/mobile.css';

applyLocalePref('system');

if (isTauri()) {
  window.addEventListener('error', (e) => {
    invoke('frontend_log', {
      msg: 'ERR ' + String((e.error && (e.error as Error).stack) || e.message).slice(0, 900),
    }).catch(() => {});
  });
  window.addEventListener('unhandledrejection', (e) => {
    invoke('frontend_log', {
      msg: 'REJ ' + String((e.reason && (e.reason as Error).stack) || e.reason).slice(0, 900),
    }).catch(() => {});
  });
}

const Root = isCompanion() ? MobileApp : App;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
