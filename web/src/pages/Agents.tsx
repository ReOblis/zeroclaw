import { useState, useEffect } from 'react';
import { Bot, User, Activity, Download, Server, AlertCircle } from 'lucide-react';
import { getAgents, getAgentLogsDownloadUrl } from '@/lib/api';
import { t } from '@/lib/i18n';
import type { Agent } from '@/types/api';

export default function Agents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAgents()
      .then(setAgents)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2" style={{ borderColor: 'var(--pc-accent)' }} />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto animate-fade-in">
      <header className="mb-10">
        <div className="flex items-center gap-3 mb-2">
          <Server className="h-6 w-6" style={{ color: 'var(--pc-accent)' }} />
          <h1 className="text-2xl font-bold" style={{ color: 'var(--pc-text-primary)' }}>{t('agents.title')}</h1>
        </div>
        <p className="text-sm" style={{ color: 'var(--pc-text-muted)' }}>{t('agents.subtitle')}</p>
      </header>

      {error && (
        <div className="card p-4 mb-6 flex items-center gap-3 animate-shake" style={{ borderColor: 'rgba(239, 68, 68, 0.2)', background: 'rgba(239, 68, 68, 0.05)', color: '#ef4444' }}>
          <AlertCircle className="h-5 w-5 shrink-0" />
          <span className="text-sm font-medium">{error}</span>
        </div>
      )}

      {agents.length === 0 ? (
        <div className="card p-12 text-center" style={{ background: 'var(--pc-bg-surface)', borderStyle: 'dashed' }}>
          <Bot className="h-12 w-12 mx-auto mb-4" style={{ color: 'var(--pc-text-faint)' }} />
          <p style={{ color: 'var(--pc-text-muted)' }}>{t('agents.no_agents')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {agents.map((agent) => (
            <div key={agent.id} className="card group overflow-hidden flex flex-col transition-all duration-300 hover:scale-[1.02]" style={{ background: 'var(--pc-bg-surface)' }}>
              <div className="p-6 flex-1">
                <div className="flex items-start justify-between mb-4">
                  <div className="p-3 rounded-2xl" style={{ background: 'var(--pc-accent-glow)', border: '1px solid var(--pc-accent-dim)' }}>
                    {agent.id === 'Assistant' ? (
                      <Bot className="h-6 w-6" style={{ color: 'var(--pc-accent)' }} />
                    ) : (
                      <User className="h-6 w-6" style={{ color: 'var(--pc-accent)' }} />
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full" style={{ background: 'rgba(16, 185, 129, 0.1)', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest">{t('dashboard.active')}</span>
                  </div>
                </div>

                <h3 className="text-lg font-bold mb-1" style={{ color: 'var(--pc-text-primary)' }}>{agent.name}</h3>
                <div className="flex items-center gap-2 mb-5">
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-md border" style={{ background: 'var(--pc-bg-base)', borderColor: 'var(--pc-border)', color: 'var(--pc-text-muted)' }}>
                    ID: {agent.id}
                  </span>
                </div>

                <div className="space-y-4">
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: 'var(--pc-text-faint)' }}>{t('agents.provider_model')}</span>
                    <span className="text-sm font-medium" style={{ color: 'var(--pc-text-secondary)' }}>{agent.provider} / {agent.model}</span>
                  </div>
                </div>
              </div>

              <div className="p-4 border-t flex items-center justify-between gap-3" style={{ background: 'var(--pc-bg-elevated)', borderColor: 'var(--pc-border)' }}>
                <a
                  href={`/logs?agent=${agent.id}`}
                  className="flex-1 btn-electric py-2.5 text-xs font-bold flex items-center justify-center gap-2"
                >
                  <Activity className="h-3.5 w-3.5" />
                  {t('agents.view_logs')}
                </a>
                <a
                  href={getAgentLogsDownloadUrl(agent.id)}
                  download
                  className="btn-soft p-2.5 rounded-xl transition-colors hover:bg-white/10"
                  title={t('agents.download_logs')}
                  style={{ background: 'rgba(255, 255, 255, 0.05)', color: 'var(--pc-text-secondary)' }}
                >
                  <Download className="h-4 w-4" />
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
