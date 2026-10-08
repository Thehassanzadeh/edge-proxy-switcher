import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { useTheme } from '../hooks/useTheme';
import Options from './Options';

function Root() {
  useTheme();
  return <Options />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
