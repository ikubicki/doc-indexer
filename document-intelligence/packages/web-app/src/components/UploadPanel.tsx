import { useState, useRef, DragEvent, ChangeEvent } from 'react';
import { uploadDocument, UploadResponse } from '../api/client.ts';

interface Props {
  onUploaded: () => void;
}

const ACCEPTED = '.pdf,.txt,.md,.docx,.png,.jpg,.jpeg';

export function UploadPanel({ onUploaded }: Props) {
  const [status, setStatus] = useState<'idle' | 'uploading' | 'success' | 'error'>('idle');
  const [result, setResult] = useState<UploadResponse | null>(null);
  const [error, setError]   = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setStatus('uploading');
    setError(null);
    setResult(null);
    try {
      const res = await uploadDocument(file);
      setResult(res);
      setStatus('success');
      onUploaded();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      setStatus('error');
    }
  }

  function onInputChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = '';
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  return (
    <section className="panel">
      <h2>Upload Document</h2>

      <div
        className={`dropzone${dragging ? ' dropzone--active' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <span className="dropzone__icon">📄</span>
        <p>Drag &amp; drop a file here, or <strong>click to browse</strong></p>
        <p className="dropzone__hint">PDF, DOCX, TXT, MD, PNG, JPG — max 100 MB</p>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED}
          style={{ display: 'none' }}
          onChange={onInputChange}
        />
      </div>

      {status === 'uploading' && (
        <div className="status status--info">⏳ Uploading…</div>
      )}

      {status === 'success' && result && (
        <div className="status status--success">
          <strong>✓ Queued for indexing</strong>
          <br />
          <span className="mono">{result.filename}</span>
          <br />
          <span className="label">ID:</span> <span className="mono">{result.documentId}</span>
        </div>
      )}

      {status === 'error' && error && (
        <div className="status status--error">⚠ {error}</div>
      )}
    </section>
  );
}
