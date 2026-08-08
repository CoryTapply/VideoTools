import { FileDropIcon } from '../icons/index.tsx';
import styles from './EmptyState.module.css';

export function EmptyState({ onOpen }: { onOpen: () => void }) {
  return (
    <div className={styles.root} onClick={onOpen}>
      <div className={styles.iconTile}>
        <FileDropIcon />
      </div>
      <div className={styles.title}>Drop an MP4 or MOV file, or open one</div>
      <div className={styles.subtitle}>Files stay on your machine. 20 GB and up is fine.</div>
    </div>
  );
}
