// Internal /dash layout — deliberately isolated from the game chrome.
// No SiteHeader, no game UI, no underwater styling. Dashboards are tools.
export default function DashLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
      {children}
    </div>
  );
}
