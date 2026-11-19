import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import { ErrorBoundary } from './components/ErrorBoundary';
import { instalarTelemetriaGlobal } from './lib/telemetriaApp';

instalarTelemetriaGlobal();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ErrorBoundary variante="global">
        <App />
      </ErrorBoundary>
    </BrowserRouter>
  </React.StrictMode>,
);
