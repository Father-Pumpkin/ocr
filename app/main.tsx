import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { BASE_PATH } from './lib/base';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root #root element not found');

createRoot(container).render(
  <React.StrictMode>
    <BrowserRouter basename={BASE_PATH || undefined}>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
