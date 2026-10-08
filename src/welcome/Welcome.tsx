import { Globe, MousePointerClick, Plus, ShieldCheck, WifiOff } from 'lucide-react';

function openOptions() {
  if (typeof chrome !== 'undefined' && chrome.runtime?.openOptionsPage) {
    void chrome.runtime.openOptionsPage();
  } else {
    window.open('options.html', '_blank');
  }
}

const steps = [
  {
    icon: <Globe size={16} className="text-blue-600 dark:text-blue-400" aria-hidden />,
    title: 'What it does',
    text: 'Save proxy profiles (HTTP, HTTPS, SOCKS4, SOCKS5) and switch between them in one click from the toolbar popup.',
  },
  {
    icon: <ShieldCheck size={16} className="text-blue-600 dark:text-blue-400" aria-hidden />,
    title: 'Stays on your device',
    text: 'Profiles and settings are stored locally. Nothing is tracked, and the connection test only runs when you ask for it.',
  },
  {
    icon: <Plus size={16} className="text-blue-600 dark:text-blue-400" aria-hidden />,
    title: 'Add your first proxy',
    text: 'Click the toolbar icon, then Add Proxy — or paste a whole proxy string and the form fills itself in.',
  },
  {
    icon: <MousePointerClick size={16} className="text-blue-600 dark:text-blue-400" aria-hidden />,
    title: 'Switch in one click',
    text: 'Click any profile to activate it. Star favorites to pin them at the top.',
  },
  {
    icon: <WifiOff size={16} className="text-blue-600 dark:text-blue-400" aria-hidden />,
    title: 'Direct Connection is your safety net',
    text: 'Pick Direct Connection any time to release extension routing and return to your browser default connection. If a proxy breaks, one click recovers.',
  },
];

export default function Welcome() {
  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <h1 className="text-2xl font-bold">Welcome to OnlyProxy</h1>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        Up and running in about 30 seconds.
      </p>

      <ol className="mt-6 space-y-3">
        {steps.map((s, i) => (
          <li
            key={s.title}
            className="flex gap-3 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-blue-50 dark:bg-blue-950/40">
              {s.icon}
            </span>
            <div>
              <p className="text-sm font-semibold">
                <span className="mr-1.5 text-neutral-400">{i + 1}.</span>
                {s.title}
              </p>
              <p className="mt-0.5 text-sm text-neutral-600 dark:text-neutral-300">{s.text}</p>
            </div>
          </li>
        ))}
      </ol>

      <p className="mt-4 rounded-xl bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
        One platform limit to know: Microsoft Edge / Chromium does not support SOCKS5
        username/password authentication for extensions. Unauthenticated SOCKS proxies and
        authenticated HTTP/HTTPS proxies work normally.
      </p>

      <div className="mt-6 flex gap-2">
        <button
          onClick={openOptions}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-blue-500"
        >
          <Plus size={15} aria-hidden /> Add your first proxy
        </button>
      </div>
    </div>
  );
}
