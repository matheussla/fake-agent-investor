const links = [["/", "Dashboard"], ["/agents", "Agents"], ["/settings", "Settings"], ["/reports", "Reports"]] as const;
type PagePath = typeof links[number][0];

export function Navigation({ current, onNavigate }: { current: PagePath; onNavigate: (path: PagePath) => void }) {
  return <nav className="section-nav" aria-label="Main navigation">{links.map(([path, label]) => <a key={path} href={path} aria-current={path === current ? "page" : undefined} onClick={event => { event.preventDefault(); onNavigate(path); }}>{label}</a>)}</nav>;
}
