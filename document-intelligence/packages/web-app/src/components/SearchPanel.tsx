import { useState, FormEvent } from 'react';
import { searchDocuments, SearchResult } from '../api/client.ts';
import { ImagePreview } from './ImagePreview.tsx';

export function SearchPanel() {
  const [query, setQuery]       = useState('');
  const [topK, setTopK]         = useState(5);
  const [minScore, setMinScore] = useState(0.6);
  const [loading, setLoading]   = useState(false);
  const [results, setResults]   = useState<SearchResult[] | null>(null);
  const [error, setError]       = useState<string | null>(null);
  const [preview, setPreview]   = useState<{ src: string; alt: string } | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setError(null);
    setResults(null);

    try {
      const res = await searchDocuments(query.trim(), topK, minScore);
      setResults(res.results);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="panel">
      <h2>Search Documents</h2>

      <form className="search-form" onSubmit={handleSubmit}>
        <input
          className="search-input"
          type="text"
          placeholder="e.g. real estate lease agreements…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={loading}
        />
        <div className="search-form__controls">
          <label className="topk-label">
            Top&nbsp;
            <input
              type="number"
              min={1}
              max={50}
              value={topK}
              onChange={(e) => setTopK(Number(e.target.value))}
              className="topk-input"
              disabled={loading}
            />
            &nbsp;results
          </label>
          <label className="topk-label">
            Min&nbsp;
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
              className="topk-input"
              disabled={loading}
            />
            &nbsp;score
          </label>
          <button className="btn btn--primary" type="submit" disabled={loading || !query.trim()}>
            {loading ? 'Searching…' : 'Search'}
          </button>
        </div>
      </form>

      {error && <div className="status status--error">⚠ {error}</div>}

      {results !== null && results.length === 0 && (
        <div className="status status--info">No results found for "{query}".</div>
      )}

      {results && results.length > 0 && (
        <ul className="results-list">
          {results.map((r) => (
            <li
              key={r.documentId}
              className={`result-card${typeof r.metadata.mimeType === 'string' && r.metadata.mimeType.startsWith('image/') ? ' result-card--has-bg' : ''}`}
              style={
                typeof r.metadata.mimeType === 'string' && r.metadata.mimeType.startsWith('image/')
                  ? { '--card-bg-image': `url(/documents/${r.documentId}/file)` } as React.CSSProperties
                  : undefined
              }
            >
              <div className="result-card__header">
                {typeof r.metadata.mimeType === 'string' && r.metadata.mimeType.startsWith('image/') ? (
                  <span
                    className="result-card__filename result-card__filename--clickable"
                    onClick={() => setPreview({ src: `/documents/${r.documentId}/file`, alt: r.filename })}
                  >
                    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
                    {r.filename}
                  </span>
                ) : (
                  <span className="result-card__filename">
                    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>
                    {r.filename}
                  </span>
                )}
                {r.score !== null && (
                  <span className="result-card__score">
                    {(r.score * 100).toFixed(1)}% match
                  </span>
                )}
              </div>

              {r.excerpt && (
                <p className="result-card__excerpt">{r.excerpt}</p>
              )}

              <div className="result-card__meta">
                {(() => {
                  const tags = typeof r.metadata.tags === 'string' && r.metadata.tags.length > 0
                    ? r.metadata.tags.split(',') : [];
                  return tags.length > 0 ? (
                    <div className="tags">
                      {tags.map(tag => <span key={tag} className="tag">{tag}</span>)}
                    </div>
                  ) : null;
                })()}
                {r.metadata.uploadedAt && (
                  <span>Uploaded: {new Date(r.metadata.uploadedAt).toLocaleString()}</span>
                )}
                <span className="mono">ID: {r.documentId}</span>
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
}

