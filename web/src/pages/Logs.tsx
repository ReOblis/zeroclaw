import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Pause,
  Play,
  ArrowDown,
  Terminal,
  Cpu,
  Bot,
  Trash2,
} from 'lucide-react';
import { SSEClient } from '@/lib/sse';
import { apiOrigin, basePath } from '@/lib/basePath';

function formatTimestamp(ts?: string): string {
  if (!ts) return new Date().toLocaleTimeString();
  const date = new Date(ts);
  return date.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '.' + date.getMilliseconds().toString().padStart(3, '0');
}

function getLevelColor(level: string): string {
  switch (level.toUpperCase()) {
    case 'ERROR': return '#ff4d4d';
    case 'WARN':
    case 'WARNING': return '#ffaa00';
    case 'INFO': return '#00e68a';
    case 'DEBUG': return '#38bdf8';
    case 'TRACE': return '#a78bfa';
    default: return 'var(--pc-text-muted)';
  }
}

interface LogEntry {
  id: string;
  timestamp: string;
  level: string;
  agent: string;
  message: string;
  target: string;
  source: 'system' | 'agent';
}

const MAX_LOGS = 1000;

export default function Logs() {
  const [searchParams] = useSearchParams();
  const initialAgent = searchParams.get('agent');

  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [source, setSource] = useState<'all' | 'system' | 'agent'>('all');
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState({ system: false, agent: false });
  const [autoScroll, setAutoScroll] = useState(true);
  const [agentFilter] = useState<string>(initialAgent || '');

  const containerRef = useRef<HTMLDivElement>(null);
  const sseSystemRef = useRef<SSEClient | null>(null);
  const sseAgentRef = useRef<SSEClient | null>(null);
  const pausedRef = useRef(false);
  const nextIdRef = useRef(0);

  useEffect(() => { pausedRef.current = paused; }, [paused]);

  const addLog = useCallback((data: any, source: 'system' | 'agent') => {
    if (pausedRef.current) return;

    const entry: LogEntry = {
      id: `l-${nextIdRef.current++}`,
      timestamp: data.timestamp || new Date().toISOString(),
      level: data.level || 'INFO',
      agent: data.agent || 'System',
      message: data.message || (typeof data === 'string' ? data : JSON.stringify(data)),
      target: data.target || '',
      source,
    };

    setEntries(prev => {
      const next = [...prev, entry];
      return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
    });
  }, []);

  useEffect(() => {
    // 1. Connect to System Logs
    const systemClient = new SSEClient(`${apiOrigin}${basePath}/api/system_logs`);
    systemClient.onConnect = () => setConnected(c => ({ ...c, system: true }));
    systemClient.onDisconnect = () => setConnected(c => ({ ...c, system: false }));
    systemClient.onEvent = (evt) => addLog(evt, 'system');
    systemClient.connect();
    sseSystemRef.current = systemClient;

    // 2. Connect to Agent Event Logs (more structured info)
    const agentClient = new SSEClient(`${apiOrigin}${basePath}/api/agent_logs`);
    agentClient.onConnect = () => setConnected(c => ({ ...c, agent: true }));
    agentClient.onDisconnect = () => setConnected(c => ({ ...c, agent: false }));
    agentClient.onEvent = (evt) => addLog(evt, 'agent');
    agentClient.connect();
    sseAgentRef.current = agentClient;

    return () => {
      systemClient.disconnect();
      agentClient.disconnect();
    };
  }, [addLog]);

  // Auto-scroll logic
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    setAutoScroll(isAtBottom);
  }, []);

  const clearLogs = () => {
    setEntries([]);
  };

  const filteredEntries = useMemo(() => {
    return entries.filter(e => {
      if (source !== 'all' && e.source !== source) return false;
      if (agentFilter && e.agent !== agentFilter && e.agent !== 'System') return false;
      return true;
    });
  }, [entries, source, agentFilter]);

  return (
    <div className="flex flex-col h-full bg-[#0d0f14] text-[#d1d5db] font-mono selection:bg-blue-500/30">
      {/* Header / Toolbar */}
      <div className="flex flex-wrap items-center justify-between px-4 py-3 border-b border-white/5 bg-black/20 backdrop-blur-md sticky top-0 z-10">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-blue-400" />
            <h2 className="text-xs font-bold uppercase tracking-widest text-white/90">Console</h2>
          </div>

          <div className="h-4 w-px bg-white/10 mx-2" />

          {/* Source Tabs */}
          <div className="flex bg-white/5 p-1 rounded-lg border border-white/5">
            <button
              onClick={() => setSource('all')}
              className={`px-3 py-1 rounded-md text-[10px] font-bold uppercase transition-all ${
                source === 'all' ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20' : 'text-white/40 hover:text-white/60'
              }`}
            >
              All
            </button>
            <button
              onClick={() => setSource('system')}
              className={`px-3 py-1 rounded-md text-[10px] font-bold uppercase transition-all ${
                source === 'system' ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/20' : 'text-white/40 hover:text-white/60'
              }`}
            >
              System
            </button>
            <button
              onClick={() => setSource('agent')}
              className={`px-3 py-1 rounded-md text-[10px] font-bold uppercase transition-all ${
                source === 'agent' ? 'bg-amber-600 text-white shadow-lg shadow-amber-600/20' : 'text-white/40 hover:text-white/60'
              }`}
            >
              Agents
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 mt-2 sm:mt-0">
          <div className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-white/5 border border-white/5 mr-2">
            <div className="flex items-center gap-1.5">
              <div className={`w-1.5 h-1.5 rounded-full ${connected.system ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]' : 'bg-red-400'}`} />
              <span className="text-[9px] uppercase font-bold text-white/50">Sys</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className={`w-1.5 h-1.5 rounded-full ${connected.agent ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]' : 'bg-red-400'}`} />
              <span className="text-[9px] uppercase font-bold text-white/50">Agent</span>
            </div>
          </div>

          <button
            onClick={() => setPaused(!paused)}
            className={`p-2 rounded-lg transition-all ${
              paused ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30' : 'bg-amber-500/10 text-amber-500 hover:bg-amber-500/20'
            }`}
            title={paused ? 'Resume' : 'Pause'}
          >
            {paused ? <Play size={16} /> : <Pause size={16} />}
          </button>

          <button
            onClick={clearLogs}
            className="p-2 rounded-lg bg-white/5 text-white/40 hover:bg-red-500/10 hover:text-red-400 transition-all"
            title="Clear Console"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      {/* Log Container */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-4 font-mono text-[12px] leading-relaxed scrollbar-thin scrollbar-thumb-white/10"
      >
        {filteredEntries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-white/20">
            <Terminal size={48} className="mb-4 opacity-20" />
            <p className="text-sm font-bold uppercase tracking-widest">{paused ? 'Stream Paused' : 'Waiting for output...'}</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {filteredEntries.map((log) => (
              <div key={log.id} className="group flex gap-3 hover:bg-white/[0.02] -mx-4 px-4 py-0.5 transition-colors">
                <span className="text-white/20 shrink-0 select-none w-20">{formatTimestamp(log.timestamp)}</span>
                <span
                  className="font-bold shrink-0 w-12 text-center select-none"
                  style={{ color: getLevelColor(log.level) }}
                >
                  {log.level.padEnd(5)}
                </span>
                <span className="text-blue-400/60 shrink-0 w-24 overflow-hidden text-ellipsis whitespace-nowrap select-none">
                  {log.source === 'system' ? <Cpu size={12} className="inline mr-1" /> : <Bot size={12} className="inline mr-1" />}
                  {log.agent}
                </span>
                <span className="text-white/40 shrink-0 w-32 overflow-hidden text-ellipsis whitespace-nowrap select-none opacity-0 group-hover:opacity-100 transition-opacity">
                  {log.target}
                </span>
                <span className="text-white/90 flex-1 break-words">
                  {log.message}
                </span>
              </div>
            ))}
          </div>
        )}

        {!autoScroll && filteredEntries.length > 0 && (
          <button
            onClick={() => {
              if (containerRef.current) {
                containerRef.current.scrollTop = containerRef.current.scrollHeight;
                setAutoScroll(true);
              }
            }}
            className="fixed bottom-20 right-8 bg-blue-600 text-white px-4 py-2 rounded-full shadow-2xl flex items-center gap-2 text-xs font-bold animate-bounce z-20"
          >
            <ArrowDown size={14} /> New Logs Below
          </button>
        )}
      </div>

      <div className="px-4 py-2 bg-black/40 border-t border-white/5 text-[9px] text-white/30 flex justify-between items-center">
        <div className="flex gap-4">
          <span>BUFFER: {entries.length} / {MAX_LOGS}</span>
          <span>FILTERED: {filteredEntries.length}</span>
        </div>
        <div className="flex gap-4 uppercase font-bold tracking-tighter">
          <span className={connected.system ? 'text-emerald-500' : 'text-red-500'}>System: {connected.system ? 'Online' : 'Offline'}</span>
          <span className={connected.agent ? 'text-emerald-500' : 'text-red-500'}>Events: {connected.agent ? 'Online' : 'Offline'}</span>
        </div>
      </div>
    </div>
  );
}
