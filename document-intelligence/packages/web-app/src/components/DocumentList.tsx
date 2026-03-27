import { useState, useEffect, useImperativeHandle, forwardRef } from 'react';
import { listDocuments, deleteAllDocuments, DocumentListItem } from '../api/client.ts';
import { ImagePreview } from './ImagePreview.tsx';

export interface DocumentListRef {
  refresh: () => void;
}

export const DocumentList = forwardRef<DocumentListRef>((_, ref) => {
  const [docs, setDocs]       = useState<DocumentListItem[]>([]);
  const [loading, setLoading]   = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [preview, setPreview]   = useState<{ src: string; alt: string } | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await listDocuments();
      setDocs(res.documents);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  useImperativeHandle(ref, () => ({ refresh: load }));

  useEffect(() => { load(); }, []);

  async function handleDeleteAll() {
    if (!confirm('Delete ALL indexed documents? This cannot be undone.')) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteAllDocuments();
      setDocs([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel__header">
        <h2>Indexed Documents</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn--secondary" onClick={load} disabled={loading || deleting}>
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
          {docs.length > 0 && (
            <button className="btn btn--danger" onClick={handleDeleteAll} disabled={loading || deleting}>
              {deleting ? 'Deleting…' : '🗑 Delete All'}
            </button>
          )}
        </div>
      </div>

      {error && <div className="status status--error">⚠ {error}</div>}

      {!loading && docs.length === 0 && !error && (
        <div className="status status--info">No documents indexed yet.</div>
      )}

      {docs.length > 0 && (
        <ul className="doc-list">
          {docs.map((d) => (
            <li
              key={d.documentId}
              className={`doc-card${d.mimeType?.startsWith('image/') ? ' doc-card--has-bg' : ''}`}
              style={
                d.mimeType?.startsWith('image/')
                  ? { '--card-bg-image': `url(/documents/${d.documentId}/file)` } as React.CSSProperties
                  : undefined
              }
            >
              {d.mimeType?.startsWith('image/') ? (
                <div
                  className="doc-card__title mono doc-card__title--clickable"
                  onClick={() => setPreview({ src: `/documents/${d.documentId}/file`, alt: d.filename })}
                >
                  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
                  {d.filename}
                </div>
              ) : (
                <div className="doc-card__title mono">
                  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>
                  {d.filename}
                </div>
              )}
              <div className="doc-card__date">
                {d.uploadedAt ? new Date(d.uploadedAt).toLocaleString() : '—'}
              </div>
              {d.tags.length > 0 && (
                <div className="tags">
                  {d.tags.map(tag => <span key={tag} className="tag">{tag}</span>)}
                </div>
              )}
              <div className="doc-card__summary">
                {d.contentSummary
                  ? d.contentSummary.slice(0, 200) + (d.contentSummary.length > 200 ? '…' : '')
                  : <span className="muted">Indexing…</span>}
              </div>
            </li>
          ))}
        </ul>
      )}

      {preview && (
        <ImagePreview src={preview.src} alt={preview.alt} onClose={() => setPreview(null)} />
      )}
    </section>
  );
});

DocumentList.displayName = 'DocumentList';
