import { useEffect, useRef } from 'react';
import { InfoIcon, KeysIcon, QueueIcon, SlidersIcon } from '../icons/index.tsx';
import { PanelTimers } from '../state/panel-timers.ts';
import styles from './Rail.module.css';
import type { ComponentType } from 'react';
import type { IconProps } from '../icons/index.tsx';
import type { PanelId } from '../state/app-state.ts';

export interface RailProps {
  panel: PanelId | null;
  pinned: PanelId | null;
  shortcuts: boolean;
  onOpenPanel: (id: PanelId) => void;
  onClosePanel: () => void;
  onToggleShortcuts: () => void;
}

interface RailButtonSpec {
  id: PanelId | 'keyboard';
  title: string;
  Icon: ComponentType<IconProps>;
}

const BUTTONS: readonly RailButtonSpec[] = [
  { id: 'info', title: 'Source info', Icon: InfoIcon },
  { id: 'export', title: 'Export settings', Icon: SlidersIcon },
  { id: 'queue', title: 'Jobs', Icon: QueueIcon },
  { id: 'keyboard', title: 'Keyboard (?)', Icon: KeysIcon },
];

export function Rail({ panel, pinned, shortcuts, onOpenPanel, onClosePanel, onToggleShortcuts }: RailProps) {
  const timers = useRef(new PanelTimers());
  // Hover-open only fires "if none is open" at the moment the 400ms delay elapses, per
  // design/reference/Video Trimmer.dc.html -- a ref keeps that check reading current state
  // rather than the state at the moment the hover began.
  const panelRef = useRef(panel);
  useEffect(() => {
    panelRef.current = panel;
  }, [panel]);

  useEffect(() => {
    const timersAtMount = timers.current;
    return () => {
      timersAtMount.dispose();
    };
  }, []);

  return (
    <div className={styles.root}>
      {BUTTONS.map(({ id, title, Icon }) => {
        const isPinned = id !== 'keyboard' && pinned === id;
        const isOpen = id === 'keyboard' ? shortcuts : panel === id;
        const raised = isOpen || isPinned;
        const className = [styles.button, raised ? styles.buttonRaised : '', isOpen && id !== 'keyboard' ? styles.buttonOpen : '']
          .filter(Boolean)
          .join(' ');

        function handleClick() {
          if (id === 'keyboard') {
            onToggleShortcuts();
            return;
          }
          if (panel === id) {
            onClosePanel();
          } else {
            onOpenPanel(id);
          }
        }

        function handleMouseEnter() {
          if (id === 'keyboard') {
            return;
          }
          timers.current.scheduleHoverOpen(() => {
            if (panelRef.current === null) {
              onOpenPanel(id);
            }
          });
        }

        function handleMouseLeave() {
          timers.current.cancelHoverOpen();
        }

        return (
          <button
            key={id}
            type="button"
            className={className}
            title={title}
            onClick={handleClick}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            <Icon />
          </button>
        );
      })}
    </div>
  );
}
