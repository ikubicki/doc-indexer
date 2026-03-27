import { useRef } from 'react';
import { UploadPanel } from './components/UploadPanel.tsx';
import { SearchPanel } from './components/SearchPanel.tsx';
import { DocumentList, DocumentListRef } from './components/DocumentList.tsx';

export default function App() {
  const listRef = useRef<DocumentListRef>(null);

  return (
    <div className="app">
      <header className="app-header">
        <h1>📚 Document Intelligence</h1>
        <p className="app-header__sub">Upload, index and semantically search your documents</p>
      </header>

      <main className="app-main">
        <div className="col col--left">
          <UploadPanel onUploaded={() => listRef.current?.refresh()} />
          <DocumentList ref={listRef} />
        </div>

        <div className="col col--right">
          <SearchPanel />
        </div>
      </main>
    </div>
  );
}
