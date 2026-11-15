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
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ErrorBoundary variante="global">
        <App />
      </ErrorBoundary>
    </BrowserRouter>
  </React.StrictMode>,
);
