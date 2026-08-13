// design/floating-chrome-changes.md's "5. Auto-hide behaviour" -- chromeVisible, default true.
// pointermove/pointerdown/keydown on window wake it and re-arm a chromeIdleMs timer; the caller
// composes `suppressHide` from every pin condition (hover over an overlay, a panel open/pinned,
// the shortcut sheet open) and the timer simply does not hide while it holds. "No file open never
// hides its chrome" needs no logic here -- TitleBar/TransportBar/NoticeChip are already unrendered
// in that state (App.tsx's showFileChrome), so this hook's output is moot until a file is open.

import { useEffect, useRef, useState } from 'react';
import { ChromeIdleTimer } from './chrome-idle-timer.ts';

export function useChromeVisibility(suppressHide: boolean): boolean {
  const [chromeVisible, setChromeVisible] = useState(true);
  const timer = useRef(new ChromeIdleTimer());
  // Read inside the window-listener closure below without re-subscribing it on every toggle.
  const suppressRef = useRef(suppressHide);

  useEffect(() => {
    suppressRef.current = suppressHide;
    timer.current.arm(suppressHide, () => {
      setChromeVisible(false);
    });
  }, [suppressHide]);

  useEffect(() => {
    const timerAtMount = timer.current;
    function wake() {
      setChromeVisible(true);
      timerAtMount.arm(suppressRef.current, () => {
        setChromeVisible(false);
      });
    }
    window.addEventListener('pointermove', wake);
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    return () => {
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
      timerAtMount.dispose();
    };
  }, []);

  return chromeVisible;
}
