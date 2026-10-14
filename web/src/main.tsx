import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { applyTheme, initialTheme } from './theme.js';
import './styles.css';

// Before the first paint, so a dark page does not flash light.
applyTheme(initialTheme());

const root = document.getElementById('root');
if (!root) throw new Error('The page has no #root element.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
