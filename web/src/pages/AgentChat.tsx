import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Send, Bot, User, AlertCircle, Copy, Check, Terminal, Shield, Sparkles, ChevronDown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { WsMessage, Agent } from '@/types/api';
import { WebSocketClient, getOrCreateSessionId } from '@/lib/ws';
import { generateUUID } from '@/lib/uuid';
import { useDraft } from '@/hooks/useDraft';
import { t } from '@/lib/i18n';
import { getSessionMessages, listAgents } from '@/lib/api';
import ToolCallCard from '@/components/ToolCallCard';
import type { ToolCallInfo } from '@/components/ToolCallCard';
import {
  loadChatHistory,
  mapServerMessagesToPersisted,
  persistedToUiMessages,
  saveChatHistory,
  uiMessagesToPersisted,
} from '@/lib/chatHistoryStorage';

interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  content: string;
  thinking?: string;
  markdown?: boolean;
  toolCall?: ToolCallInfo;
  timestamp: Date;
}

const DRAFT_KEY = 'agent-chat';

export default function AgentChat() {
  const navigate = useNavigate();
  const sessionIdRef = useRef(getOrCreateSessionId());
  const { draft, saveDraft, clearDraft } = useDraft(DRAFT_KEY);
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const persisted = loadChatHistory(sessionIdRef.current);
    return persisted.length > 0 ? persistedToUiMessages(persisted) : [];
  });
  const [historyReady, setHistoryReady] = useState(false);
  const [input, setInput] = useState(draft);
  const [typing, setTyping] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [currentAgent, setCurrentAgent] = useState<Agent | null>(null);

  const wsRef = useRef<WebSocketClient | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const pendingContentRef = useRef('');
  const pendingThinkingRef = useRef('');
  const capturedThinkingRef = useRef('');
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingThinking, setStreamingThinking] = useState('');

  // 1. Load Agents
  useEffect(() => {
    listAgents().then(list => {
      setAgents(list);
      setCurrentAgent(list[0] || null);
    }).catch(console.error);
  }, []);

  // 2. Draft Persistence
  useEffect(() => {
    saveDraft(input);
  }, [input, saveDraft]);

  // 3. History Hydration
  useEffect(() => {
    const sid = sessionIdRef.current;
    let cancelled = false;

    (async () => {
      try {
        const res = await getSessionMessages(sid);
        if (cancelled) return;
        if (res.session_persistence && res.messages.length > 0) {
          setMessages((prev) =>
            prev.length > 0 ? prev : persistedToUiMessages(mapServerMessagesToPersisted(res.messages)),
          );
        } else if (!res.session_persistence) {
          setMessages((prev) => {
            if (prev.length > 0) return prev;
            const ls = loadChatHistory(sid);
            return ls.length ? persistedToUiMessages(ls) : prev;
          });
        }
      } catch {
        if (!cancelled) {
          setMessages((prev) => {
            if (prev.length > 0) return prev;
            const ls = loadChatHistory(sid);
            return ls.length ? persistedToUiMessages(ls) : prev;
          });
        }
      } finally {
        if (!cancelled) setHistoryReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // 4. Mirroring logs
  useEffect(() => {
    if (!historyReady) return;
    saveChatHistory(sessionIdRef.current, uiMessagesToPersisted(messages));
  }, [messages, historyReady]);

  // 5. WebSocket setup
  useEffect(() => {
    const ws = new WebSocketClient();
    ws.onOpen = () => { setConnected(true); setError(null); };
    ws.onClose = (ev: CloseEvent) => {
      setConnected(false);
      if (ev.code !== 1000 && ev.code !== 1001) {
        setError(`Connection closed unexpectedly (code: ${ev.code}). Please check your configuration.`);
      }
    };
    ws.onError = () => setError(t('agent.connection_error'));
    ws.onMessage = (msg: WsMessage) => {
      switch (msg.type) {
        case 'thinking':
          setTyping(true);
          pendingThinkingRef.current += msg.content ?? '';
          setStreamingThinking(pendingThinkingRef.current);
          break;
        case 'chunk':
          setTyping(true);
          pendingContentRef.current += msg.content ?? '';
          setStreamingContent(pendingContentRef.current);
          break;
        case 'chunk_reset':
          capturedThinkingRef.current = pendingThinkingRef.current;
          pendingContentRef.current = '';
          pendingThinkingRef.current = '';
          setStreamingContent('');
          setStreamingThinking('');
          break;
        case 'message':
        case 'done': {
          const content = msg.full_response ?? msg.content ?? pendingContentRef.current;
          const thinking = capturedThinkingRef.current || pendingThinkingRef.current || undefined;
          if (content) {
            setMessages((prev) => [
              ...prev,
              { id: generateUUID(), role: 'agent', content, thinking, markdown: true, timestamp: new Date() },
            ]);
          }
          pendingContentRef.current = '';
          pendingThinkingRef.current = '';
          capturedThinkingRef.current = '';
          setStreamingContent('');
          setStreamingThinking('');
          setTyping(false);
          break;
        }
        case 'tool_call': {
          const toolName = msg.name ?? 'unknown';
          const toolArgs = msg.args;
          setMessages((prev) => {
            const argsKey = JSON.stringify(toolArgs ?? {});
            const isDuplicate = prev.some(
              (m) => m.toolCall && m.toolCall.output === undefined && m.toolCall.name === toolName && JSON.stringify(m.toolCall.args ?? {}) === argsKey,
            );
            if (isDuplicate) return prev;
            return [
              ...prev,
              { id: generateUUID(), role: 'agent', content: `${t('agent.tool_call_prefix')} ${toolName}(${argsKey})`, toolCall: { name: toolName, args: toolArgs }, timestamp: new Date() },
            ];
          });
          break;
        }
        case 'tool_result': {
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.toolCall && m.toolCall.output === undefined);
            if (idx !== -1) {
              const updated = [...prev];
              updated[idx] = { ...prev[idx]!, toolCall: { ...prev[idx]!.toolCall!, output: msg.output ?? '' } };
              return updated;
            }
            return [
              ...prev,
              { id: generateUUID(), role: 'agent', content: `${t('agent.tool_result_prefix')} ${msg.output ?? ''}`, toolCall: { name: msg.name ?? 'unknown', output: msg.output ?? '' }, timestamp: new Date() },
            ];
          });
          break;
        }
        case 'error':
          setMessages((prev) => [
            ...prev,
            { id: generateUUID(), role: 'agent', content: `${t('agent.error_prefix')} ${msg.message ?? t('agent.unknown_error')}`, timestamp: new Date() },
          ]);
          setTyping(false);
          break;
      }
    };

    ws.connect();
    wsRef.current = ws;
    return () => ws.disconnect();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typing, streamingContent]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || !wsRef.current?.connected) return;

    setMessages((prev) => [
      ...prev,
      { id: generateUUID(), role: 'user', content: trimmed, timestamp: new Date() },
    ]);

    try {
      wsRef.current.sendMessage(trimmed);
      setTyping(true);
      pendingContentRef.current = '';
      pendingThinkingRef.current = '';
    } catch {
      setError(t('agent.send_error'));
    }

    setInput('');
    clearDraft();
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
  };

  const handleCopy = useCallback((msgId: string, content: string) => {
    const onSuccess = () => {
      setCopiedId(msgId);
      setTimeout(() => setCopiedId(p => p === msgId ? null : p), 2000);
    };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(content).then(onSuccess).catch(() => fallbackCopy(content) && onSuccess());
    } else {
      fallbackCopy(content) && onSuccess();
    }
  }, []);

  function fallbackCopy(text: string): boolean {
    const t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); return true; } catch { return false; } finally { document.body.removeChild(t); }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] relative overflow-hidden">
      {/* Premium Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-white/5 bg-white/[0.02] backdrop-blur-xl z-20">
        <div className="flex items-center gap-4">
          <div className="relative">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
              <Bot className="text-white h-5 w-5" />
            </div>
            <div className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-[#121214] ${connected ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-red-500'}`} />
          </div>

          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-white tracking-wide">
                {currentAgent?.name || 'ZeroClaw Assistant'}
              </span>
              {currentAgent?.is_default && (
                <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-white/5 border border-white/10 text-[9px] font-black uppercase tracking-tighter text-blue-400">
                  <Shield size={10} /> Core
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-[10px] text-white/40 font-medium">
              <Sparkles size={10} className="text-amber-400" />
              <span>{currentAgent?.model || '2.0-flash'}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(`/logs?agent=${currentAgent?.name || 'Vy'}`)}
            className="group flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20 transition-all"
          >
            <Terminal size={14} className="text-white/40 group-hover:text-blue-400 transition-colors" />
            <span className="text-[11px] font-bold text-white/60">Live Logs</span>
          </button>

          <div className="h-4 w-px bg-white/10 mx-1" />

          {agents.length > 1 && (
            <button className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white/5 border border-white/10 text-white/60 hover:text-white transition-all">
              <span className="text-[11px] font-bold">Switch Agent</span>
              <ChevronDown size={14} />
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mx-6 mt-4 px-4 py-2 rounded-xl flex items-center gap-3 text-xs border border-red-500/20 bg-red-500/5 text-red-400 animate-in slide-in-from-top">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-thin scrollbar-thumb-white/5">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center space-y-6 opacity-40">
            <div className="h-24 w-24 rounded-[40px] bg-gradient-to-tr from-white/[0.02] to-white/[0.08] border border-white/10 flex items-center justify-center animate-pulse">
              <Bot className="h-10 w-10 text-white" />
            </div>
            <div>
              <p className="text-lg font-bold text-white tracking-tight">I'm {currentAgent?.name || 'Vy'}</p>
              <p className="text-sm text-white/60">How can I assist you today?</p>
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`group flex items-start gap-4 ${msg.role === 'user' ? 'flex-row-reverse animate-in slide-in-from-right fade-in duration-300' : 'animate-in slide-in-from-left fade-in duration-300'}`}
          >
            <div className={`flex-shrink-0 w-8 h-8 rounded-xl flex items-center justify-center border ${msg.role === 'user' ? 'bg-blue-600 border-blue-500 text-white' : 'bg-white/5 border-white/10 text-blue-400'}`}>
              {msg.role === 'user' ? <User size={14} /> : <Bot size={14} />}
            </div>
            <div className={`relative max-w-[85%] sm:max-w-[70%] space-y-2`}>
              <div className={`rounded-2xl px-4 py-3 border shadow-sm ${msg.role === 'user' ? 'bg-blue-600/10 border-blue-500/20 text-white' : 'bg-white/[0.03] border-white/10 text-white/90'}`}>
                {msg.thinking && (
                  <details className="mb-3 group/think">
                    <summary className="text-[10px] font-bold uppercase tracking-widest text-white/30 cursor-pointer hover:text-white/50 transition-colors list-none flex items-center gap-2">
                       <span className="w-1.5 h-1.5 rounded-full bg-amber-500/50" /> Thinking Process
                    </summary>
                    <pre className="mt-2 text-xs text-white/40 whitespace-pre-wrap break-words leading-relaxed overflow-auto max-h-60 p-3 rounded-xl bg-black/20 border border-white/5 font-mono">
                      {msg.thinking}
                    </pre>
                  </details>
                )}
                {msg.toolCall ? (
                  <ToolCallCard toolCall={msg.toolCall} />
                ) : msg.markdown ? (
                  <div className="text-[14px] leading-relaxed chat-markdown font-medium">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-[14px] whitespace-pre-wrap leading-relaxed font-medium">{msg.content}</p>
                )}
              </div>
              <div className={`flex items-center gap-3 px-1 ${msg.role === 'user' ? 'justify-end' : ''}`}>
                <span className="text-[10px] uppercase font-black tracking-tighter text-white/20">{msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                <button
                  onClick={() => handleCopy(msg.id, msg.content)}
                  className="hidden group-hover:flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-white/30 hover:text-blue-400 transition-colors"
                >
                  {copiedId === msg.id ? <Check size={10} className="text-emerald-500" /> : <Copy size={10} />}
                  {copiedId === msg.id ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          </div>
        ))}

        {typing && (
          <div className="flex items-start gap-4 animate-in fade-in duration-500">
            <div className="flex-shrink-0 w-8 h-8 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-blue-400">
              <Bot size={14} className="animate-pulse" />
            </div>
            <div className="rounded-2xl px-4 py-3 bg-white/[0.03] border border-white/10 max-w-[85%] sm:max-w-[70%]">
              {streamingThinking && (
                 <div className="mb-2">
                    <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-white/30 mb-2">
                       <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping" /> Analyzing...
                    </div>
                    <pre className="text-xs text-white/20 whitespace-pre-wrap max-h-32 overflow-hidden blur-[0.5px]">
                      {streamingThinking}
                    </pre>
                 </div>
              )}
              {streamingContent ? (
                <p className="text-[14px] text-white/90 leading-relaxed font-medium animate-in fade-in slide-in-from-bottom-1">{streamingContent}</p>
              ) : !streamingThinking && (
                <div className="flex gap-1.5 py-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-500/50 animate-bounce" />
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-500/50 animate-bounce delay-150" />
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-500/50 animate-bounce delay-300" />
                </div>
              )}
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="p-6">
        <div className="max-w-4xl mx-auto relative group">
          <div className="absolute -inset-0.5 bg-gradient-to-r from-blue-500/20 to-indigo-500/20 rounded-3xl blur opacity-0 group-focus-within:opacity-100 transition duration-500" />
          <div className="relative flex items-end gap-3 p-2 rounded-3xl bg-[#1a1b1e] border border-white/10 shadow-2xl">
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              placeholder={connected ? `Message ${currentAgent?.name || 'Vy'}...` : 'Connecting to Core...'}
              disabled={!connected}
              className="flex-1 bg-transparent px-4 py-3.5 text-[14px] text-white placeholder-white/20 focus:outline-none resize-none max-h-60"
              style={{ height: 'auto' }}
            />
            <button
              onClick={handleSend}
              disabled={!connected || !input.trim()}
              className="mb-1 mr-1 p-3 rounded-2xl bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-20 disabled:grayscale transition-all shadow-lg shadow-blue-600/20"
            >
              <Send size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
