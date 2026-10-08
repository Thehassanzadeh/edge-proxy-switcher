import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { useTheme } from '../hooks/useTheme';
import Welcome from './Welcome';

function Root() {
  useTheme();
  return <Welcome />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
