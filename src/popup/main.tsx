import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { useTheme } from '../hooks/useTheme';
import Popup from './Popup';

function Root() {
  useTheme();
  return <Popup />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
