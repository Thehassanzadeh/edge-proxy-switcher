import { useCallback, useEffect, useState } from 'react';
import { ProxyService } from '../services/ProxyService';
import { StorageService } from '../storage/StorageService';
import type { ThemePref } from '../types';

function resolveDark(theme: ThemePref): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function useTheme() {
  const [theme, setTheme] = useState<ThemePref>('system');
  const [dark, setDark] = useState(false);

  useEffect(() => {
    let alive = true;
    void StorageService.getSettings().then((s) => {
      if (alive) setTheme(s.theme);
    });
    return StorageService.onChanged(() => {
      void StorageService.getSettings().then((s) => {
        if (alive) setTheme(s.theme);
      });
    });
  }, []);

  useEffect(() => {
    const apply = () => {
      const isDark = resolveDark(theme);
      setDark(isDark);
      document.documentElement.classList.toggle('dark', isDark);
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => theme === 'system' && apply();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  const saveTheme = useCallback(async (t: ThemePref) => {
    await ProxyService.patchSettings({ theme: t });
    setTheme(t);
  }, []);

  return { theme, dark, saveTheme };
}
