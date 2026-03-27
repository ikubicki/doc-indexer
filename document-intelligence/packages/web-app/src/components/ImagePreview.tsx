import { useEffect } from 'react';

interface ImagePreviewProps {
  src: string;
  alt: string;
  onClose: () => void;
}

export function ImagePreview({ src, alt, onClose }: ImagePreviewProps) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="overlay__content" onClick={(e) => e.stopPropagation()}>
        <button className="overlay__close" onClick={onClose}>✕</button>
        <img className="overlay__image" src={src} alt={alt} />
        <div className="overlay__filename">{alt}</div>
      </div>
    </div>
  );
}
