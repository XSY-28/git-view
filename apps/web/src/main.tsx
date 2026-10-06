import { createRoot } from 'react-dom/client';
import { App } from './App';
import { I18nProvider } from './i18n';
import './styles.css';

// Remove the one-use credential before rendering, fetching, or navigating anywhere.
const initialSessionId = new URLSearchParams(window.location.search).get('session') || '';
const ticket = new URLSearchParams(window.location.hash.slice(1)).get('ticket');
if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search);
createRoot(document.getElementById('root')!).render(<I18nProvider><App initialSessionId={initialSessionId} ticket={ticket}/></I18nProvider>);
