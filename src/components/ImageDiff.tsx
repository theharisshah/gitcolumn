import { useEffect, useState } from 'react';
import type { Blob, BlobSpec } from '../../shared/types';
import { api } from '../lib/api';
import { useRepo } from '../repo/RepoContext';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
export const isImagePath = (p: string) => IMAGE_EXT.test(p);

type Mode = 'side' | 'onion';

interface Loaded {
  blob: Blob | null;
  width?: number;
  height?: number;
}

function useBlob(spec?: BlobSpec): Loaded | undefined {
  const { repo, version } = useRepo();
  const [state, setState] = useState<Loaded | undefined>(undefined);
  const key = spec ? JSON.stringify(spec) : '';
  useEffect(() => {
    if (!spec) {
      setState(undefined);
      return;
    }
    let cancelled = false;
    api
      .blob(repo.path, spec)
      .then((blob) => {
        if (cancelled) return;
        if (!blob) return setState({ blob: null });
        const img = new Image();
        img.onload = () => !cancelled && setState({ blob, width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => !cancelled && setState({ blob: null });
        img.src = blob.dataUrl;
      })
      .catch(() => !cancelled && setState({ blob: null }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.path, key, version]);
  return state;
}

function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function ImageDiff({ before, after }: { before?: BlobSpec; after?: BlobSpec }) {
  const a = useBlob(before);
  const b = useBlob(after);
  const [mode, setMode] = useState<Mode>('side');
  const [opacity, setOpacity] = useState(0.5);
  const both = !!(a?.blob && b?.blob);

  const panel = (label: string, cls: string, l?: Loaded, spec?: BlobSpec) => (
    <figure className={`image-panel ${cls}`}>
      <figcaption>
        <span className="image-label">{label}</span>
        {l?.blob && (
          <span className="muted small">
            {l.width}×{l.height} · {formatSize(l.blob.size)}
          </span>
        )}
      </figcaption>
      <div className="image-frame checkerboard">
        {!spec ? (
          <span className="muted small">—</span>
        ) : !l ? (
          <span className="muted small">Loading…</span>
        ) : l.blob ? (
          <img src={l.blob.dataUrl} alt={label} />
        ) : (
          <span className="muted small">Can’t display this image</span>
        )}
      </div>
    </figure>
  );

  return (
    <div className="image-diff">
      {both && (
        <div className="image-diff-toolbar">
          <div className="segmented">
            <button className={mode === 'side' ? 'active' : ''} onClick={() => setMode('side')}>
              Side by Side
            </button>
            <button className={mode === 'onion' ? 'active' : ''} onClick={() => setMode('onion')}>
              Onion Skin
            </button>
          </div>
          {mode === 'onion' && (
            <input type="range" min={0} max={1} step={0.01} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} title="Blend between before and after" />
          )}
        </div>
      )}
      {mode === 'onion' && both ? (
        <div className="image-frame checkerboard onion">
          <img src={a!.blob!.dataUrl} alt="Before" />
          <img src={b!.blob!.dataUrl} alt="After" style={{ opacity }} className="onion-top" />
        </div>
      ) : (
        <div className="image-panels">
          {before && panel('Before', 'before', a, before)}
          {after && panel('After', 'after', b, after)}
        </div>
      )}
    </div>
  );
}
