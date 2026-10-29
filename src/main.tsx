import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

interface Site {
  hostname: string; title: string | null; description: string | null; favicon_url: string | null;
  repository_url: string | null; first_seen_at: string; last_checked_at: string | null;
  current_status: 'online' | 'offline' | 'unknown' | 'blocked'; archived: number;
}
interface Archive {
  sites: Site[]; counts: { total: number; online: number }; filtered: number; page_size: number;
  last_sync: { finished_at: string; status: string } | null;
}
const date = (value: string | null, time = false) => value ? new Intl.DateTimeFormat('ko-KR', {
  year: 'numeric', month: '2-digit', day: '2-digit', ...(time ? { hour: '2-digit', minute: '2-digit' } as const : {}),
}).format(new Date(value)) : '아직 없음';
const statusLabel = { online: '온라인', offline: '오프라인', unknown: '미확인', blocked: '접근 제한' };

function Icon({ url, title }: { url: string | null; title: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return <span className="site-icon" aria-hidden="true">{url && !failed
    ? <img src={url} alt="" width="24" height="24" loading="lazy" referrerPolicy="no-referrer" crossOrigin="anonymous" onError={() => setFailed(true)} />
    : title.slice(0, 1).toUpperCase()}</span>;
}
function App() {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('name');
  const [page, setPage] = useState(0);
  const [data, setData] = useState<Archive | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('lake-archive-theme') ?? 'system'; } catch { return 'system'; }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('lake-archive-theme', theme); } catch { /* Storage is optional. */ }
  }, [theme]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: query, status: filter, sort, offset: String(page * 60) });
        const response = await fetch(`/api/sites?${params}`, { signal: controller.signal });
        if (!response.ok) throw new Error('api');
        setData(await response.json()); setError(false);
      } catch { if (!controller.signal.aborted) setError(true); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, filter, sort, page, reload]);
  const update = (setter: (value: string) => void, value: string) => { setter(value); setPage(0); };
  return <main>
    <header className="masthead">
      <a className="wordmark" href="/" aria-label="Lake Archive 홈"><span className="mark">L</span> LAKE <span className="wordmark-light">/ ARCHIVE</span></a>
      <label className="theme-control"><span className="sr-only">화면 테마</span>
        <select value={theme} onChange={event => setTheme(event.target.value)} aria-label="화면 테마">
          <option value="system">시스템 테마</option><option value="light">라이트</option><option value="dark">다크</option>
        </select>
      </label>
    </header>
    <section className="intro" aria-labelledby="heading">
      <div className="eyebrow"><span className="live-dot" /> A PERSONAL WEB INDEX</div>
      <h1 id="heading">Lake Archive<span className="title-dot">.</span></h1>
      <p className="intro-text">만들어 둔 웹사이트를, 다시 찾는 곳.</p>
      <div className="overview">
        <div className="stat"><span className="stat-value">{data?.counts.total ?? '—'}</span><span>보관된 사이트</span></div>
        <div className="stat"><span className="stat-value online-number">{data?.counts.online ?? '—'}</span><span>현재 온라인</span></div>
        <div className="sync"><span className="sync-label">매시간 자동 탐색</span><span>마지막 동기화 · {date(data?.last_sync?.finished_at ?? null, true)}</span>
          {data?.last_sync && data.last_sync.status !== 'success' && <span className="sync-warning">일부 항목을 확인하지 못했습니다</span>}
        </div>
      </div>
    </section>
    <section className="archive" aria-label="사이트 인덱스" aria-busy={loading}>
      <div className="section-heading"><h2>사이트 인덱스</h2><span className="small-mono">INDEX / {String(data?.filtered ?? 0).padStart(2, '0')}</span></div>
      <div className="toolbar">
        <label className="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>
          <span className="sr-only">사이트 검색</span><input type="search" placeholder="이름 또는 도메인 검색" value={query} onChange={e => update(setQuery, e.target.value)} /></label>
        <div className="filters" role="group" aria-label="접속 상태 필터">
          {[['all', '전체'], ['online', '온라인'], ['offline', '오프라인']].map(([value, label]) =>
            <button key={value} aria-pressed={filter === value} onClick={() => update(setFilter, value)}>{label}</button>)}
        </div>
        <label className="sort"><span className="sr-only">정렬 기준</span><select value={sort} onChange={e => update(setSort, e.target.value)}>
          <option value="name">이름순</option><option value="first">최초 발견순</option><option value="checked">최근 확인순</option>
        </select></label>
      </div>
      <div aria-live="polite" className="result-line">{loading ? '사이트를 불러오는 중…' : `${data?.filtered ?? 0}개의 사이트`}</div>
      {error && <div className="empty" role="alert"><h3>인덱스를 불러오지 못했습니다.</h3><p>잠시 후 다시 시도해 주세요.</p><button className="retry" onClick={() => setReload(value => value + 1)}>다시 시도</button></div>}
      {!error && !loading && !data?.sites.length && <div className="empty"><span className="empty-symbol" aria-hidden="true">⌑</span><h3>{query || filter !== 'all' ? '일치하는 사이트가 없습니다.' : '아직 공개된 사이트가 없습니다.'}</h3><p>{query || filter !== 'all' ? '검색어나 필터를 바꿔 보세요.' : '자동 탐색 후 공개 조건을 충족한 사이트가 여기에 표시됩니다.'}</p></div>}
      {!error && <div className="site-grid">{data?.sites.map(site => <article className="site-card" key={site.hostname}>
        <div className="card-top"><Icon url={site.favicon_url} title={site.title || site.hostname} /><span className={`status status-${site.current_status}`}><span />{statusLabel[site.current_status]}</span></div>
        <h3><a href={`https://${site.hostname}/`} target="_blank" rel="noopener noreferrer">{site.title || site.hostname}</a></h3>
        <p className="hostname">{site.hostname}</p>
        <p className="description">{site.description || '저장된 설명이 없습니다.'}</p>
        <div className="card-meta"><span>최초 발견 <time dateTime={site.first_seen_at}>{date(site.first_seen_at)}</time></span>{!!site.archived && <span className="archived-tag">이전 기록</span>}</div>
        <div className="card-footer"><a className="visit-link" href={`https://${site.hostname}/`} target="_blank" rel="noopener noreferrer">사이트 방문 <span aria-hidden="true">↗</span><span className="sr-only"> (새 탭)</span></a>
          {site.repository_url && <a className="github-link" href={site.repository_url} target="_blank" rel="noopener noreferrer">GitHub <span aria-hidden="true">↗</span><span className="sr-only"> (새 탭)</span></a>}</div>
      </article>)}</div>}
      {data && data.filtered > 60 && <nav className="pagination" aria-label="결과 페이지"><button disabled={!page || loading} onClick={() => setPage(page - 1)}>← 이전</button><span>{page + 1} / {Math.ceil(data.filtered / 60)}</span><button disabled={(page + 1) * 60 >= data.filtered || loading} onClick={() => setPage(page + 1)}>다음 →</button></nav>}
    </section>
    <footer><span>LAKE ARCHIVE</span><p>새로 만든 곳도, 오래된 곳도.</p><span className="footer-note">lakekim.com의 웹사이트 기록</span></footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
