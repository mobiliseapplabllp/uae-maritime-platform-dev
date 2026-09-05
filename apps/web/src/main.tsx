import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import './fonts.css';
import './i18n';
import { store } from './store';
import App from './App';
import ErrorBoundary from './components/common/ErrorBoundary';

const Router = import.meta.env.VITE_DEMO === '1' ? HashRouter : BrowserRouter;

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Provider store={store}>
        {/* Navigations render synchronously. Inside a React transition, React 18 drops the state a closing menu or
            dialog sets when its exit ends, so a filter that also writes the URL could leave an invisible, closed menu
            over the page and every click after it would land on nothing. The trade is that a route not yet loaded shows
            its loader rather than the previous page — which the module switch already does on purpose. */}
        <Router useTransitions={false}>
          <App />
        </Router>
      </Provider>
    </ErrorBoundary>
  </React.StrictMode>,
);
