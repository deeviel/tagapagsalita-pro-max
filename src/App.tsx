import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Settings, Play, Shield, Bot, AlertTriangle, MonitorSpeaker, Trash2, ExternalLink } from 'lucide-react';

export default function App() {
  const [discordToken, setDiscordToken] = useState('');
  const [discordMusicToken, setDiscordMusicToken] = useState('');
  const [isDiscordConnected, setIsDiscordConnected] = useState(false);
  const [isDiscordConnecting, setIsDiscordConnecting] = useState(false);
  
  const [isDiscordMusicConnected, setIsDiscordMusicConnected] = useState(false);
  const [isDiscordMusicConnecting, setIsDiscordMusicConnecting] = useState(false);

  const [availableChannels, setAvailableChannels] = useState<{id:string, name:string, guildName:string}[]>([]);
  const [testVoiceText, setTestVoiceText] = useState('Hello world, I am ready.');
  const [testVoiceChannelId, setTestVoiceChannelId] = useState('');
  const [voiceLang, setVoiceLang] = useState('en-female');
  const [youtubeCookie, setYoutubeCookie] = useState('');
  const [musicBotHelpText, setMusicBotHelpText] = useState('');
  const [isSavingHelpText, setIsSavingHelpText] = useState(false);
  const [globalVolume, setGlobalVolume] = useState(100);

  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ message, type });
    setTimeout(() => {
      setToast(prev => prev?.message === message ? null : prev);
    }, 4500);
  };

  const fetchDiscordStatus = () => {
     fetch('/api/discord/status')
       .then(async res => {
          if (!res.ok) return null;
          const text = await res.text();
          try { return JSON.parse(text); } catch { return null; }
       })
       .then(data => {
          if (!data) return;
          setIsDiscordConnected(data.connected);
          if (data.connected) fetchDiscordChannels();
       })
       .catch(err => console.error(err));
       
     fetch('/api/discord-music/status')
       .then(async res => {
          if (!res.ok) return null;
          const text = await res.text();
          try { return JSON.parse(text); } catch { return null; }
       })
       .then(data => {
          if (!data) return;
          setIsDiscordMusicConnected(data.connected);
       })
       .catch(err => console.error(err));
  };

  const fetchDiscordChannels = () => {
     fetch('/api/discord/channels')
       .then(async res => {
          if (!res.ok) return null;
          const text = await res.text();
          try { return JSON.parse(text); } catch { return null; }
       })
       .then(data => {
         if (!data) return;
         if (Array.isArray(data)) {
           setAvailableChannels(data);
           if (data.length > 0 && !testVoiceChannelId) {
             setTestVoiceChannelId(data[0].id);
           }
         }
       })
       .catch(err => console.error("Failed to load discord channels", err));
  };

  useEffect(() => {
    fetchDiscordStatus();
    const intv = setInterval(fetchDiscordStatus, 5000);

    fetch('/api/discord-music/helptext')
      .then(async res => {
        if (!res.ok) return null;
        const text = await res.text();
        try { return JSON.parse(text); } catch { return null; }
      })
      .then(data => {
        if (data && data.helpText) setMusicBotHelpText(data.helpText);
      })
      .catch(err => console.error('Error loading help text', err));

    fetch('/api/discord-music/volume')
      .then(async res => {
        if (!res.ok) return null;
        const text = await res.text();
        try { return JSON.parse(text); } catch { return null; }
      })
      .then(data => {
        if (data && typeof data.volume === 'number') setGlobalVolume(data.volume);
      })
      .catch(err => console.error('Error loading volume', err));

    fetch('/api/settings')
      .then(async res => {
          if (!res.ok) return null;
          const text = await res.text();
          try { return JSON.parse(text); } catch { return null; }
       })
      .then(data => {
        if (!data) return;
        if (typeof data.voiceLang === 'string') setVoiceLang(data.voiceLang);
        if (typeof data.youtubeCookie === 'string') setYoutubeCookie(data.youtubeCookie);
      })
      .catch(err => console.error("Failed to load settings", err));

    return () => clearInterval(intv);
  }, []);

  const handleConnectDiscord = async () => {
    setIsDiscordConnecting(true);
    try {
      const res = await fetch('/api/discord/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: discordToken })
      });
      const data = await res.json();
      if (data.success) {
        showToast('Discord Connected!', 'success');
        setIsDiscordConnected(true);
        setDiscordToken('');
        fetchDiscordChannels();
      } else {
        showToast(data.error || 'Connection failed', 'error');
      }
    } catch (e: any) {
      showToast(e.message, 'error');
    }
    setIsDiscordConnecting(false);
  };

  const handleConnectDiscordMusic = async () => {
    setIsDiscordMusicConnecting(true);
    try {
      const res = await fetch('/api/discord-music/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: discordMusicToken })
      });
      const data = await res.json();
      if (data.success) {
        showToast('Music Bot Connected!', 'success');
        setIsDiscordMusicConnected(true);
        setDiscordMusicToken('');
      } else {
        showToast(data.error || 'Connection failed', 'error');
      }
    } catch (e: any) {
      showToast(e.message, 'error');
    }
    setIsDiscordMusicConnecting(false);
  };

  const handleDisconnectDiscord = async () => {
    try {
      const res = await fetch('/api/discord/disconnect', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast('Disconnected from Discord.', 'info');
        setIsDiscordConnected(false);
        setAvailableChannels([]);
      }
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  };

  const handleDisconnectDiscordMusic = async () => {
    try {
      const res = await fetch('/api/discord-music/disconnect', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast('Music Bot Disconnected.', 'info');
        setIsDiscordMusicConnected(false);
      }
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  };

  const handleTestVoice = async () => {
    if (!testVoiceChannelId) {
      showToast('Select a channel first', 'error');
      return;
    }
    try {
      const res = await fetch('/api/discord/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: testVoiceChannelId, lang: voiceLang, text: testVoiceText })
      });
      const data = await res.json();
      if (data.success) {
        showToast('Voice message sent!', 'success');
      } else {
        showToast(data.error || 'Voice error', 'error');
      }
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  };

  const handleSaveSettings = async () => {
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceLang, youtubeCookie })
      });
      if (res.ok) {
        showToast('Settings saved!', 'success');
      }
    } catch (e) {}
  };

  const handleSaveHelpText = async () => {
    setIsSavingHelpText(true);
    try {
      const res = await fetch('/api/discord-music/helptext', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ helpText: musicBotHelpText })
      });
      if (res.ok) {
        showToast('Help text saved!', 'success');
      } else {
        showToast('Failed to save help text.', 'error');
      }
    } catch (e) {
      showToast('Failed to save help text.', 'error');
    }
    setIsSavingHelpText(false);
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 font-sans p-6 overflow-y-auto selection:bg-indigo-500/30">
      <div className="max-w-4xl mx-auto space-y-6">
        
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-center justify-between bg-gray-900 border border-gray-800 rounded-xl p-6">
          <div className="flex items-center gap-4">
            <div className="bg-indigo-500/20 p-3 rounded-xl border border-indigo-500/30">
              <MonitorSpeaker className="w-8 h-8 text-indigo-400" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">TTS Discord Bot</h1>
              <p className="text-sm text-gray-400">Stream modern text-to-speech directly to voice channels</p>
            </div>
          </div>
          
          <div className="mt-4 sm:mt-0">
            {isDiscordConnected ? (
              <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-4 py-2 rounded-lg flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                <span className="font-medium">Bot Online</span>
              </div>
            ) : (
              <div className="bg-gray-800 border border-gray-700 text-gray-400 px-4 py-2 rounded-lg flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-gray-500"></div>
                <span className="font-medium">Disconnected</span>
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Music Bot Connection Card */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 flex flex-col justify-between">
            <div>
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-lg font-medium flex items-center gap-2">
                  <Shield className="w-5 h-5 text-indigo-400" /> Music Bot Connection
                </h2>
                {isDiscordMusicConnected && (
                  <button 
                    onClick={handleDisconnectDiscordMusic}
                    className="text-xs flex items-center gap-1 text-red-400 hover:text-red-300 transition-colors bg-red-400/10 px-2 py-1 rounded"
                  >
                    <Trash2 className="w-3 h-3" /> Disconnect
                  </button>
                )}
              </div>
              <p className="text-sm text-gray-400 mb-6 border-l-2 border-indigo-500/50 pl-3 flex flex-col gap-3">
                <span>To connect the separate music bot, provide a valid Discord Bot Token. The music bot plays media from URLs or search queries (e.g. <code>!play lofi hip hop</code>).</span>
                <a href="https://discord.com/oauth2/authorize?client_id=1515269804011819128&permissions=36768832&integration_type=0&scope=bot" target="_blank" rel="noreferrer" className="inline-flex items-center justify-center gap-2 bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 border border-indigo-500/20 rounded-md px-3 py-1.5 text-xs font-medium transition-colors w-fit">
                   <ExternalLink className="w-3 h-3" /> Install Music Bot
                </a>
              </p>
              
              {!isDiscordMusicConnected ? (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">Music Bot Token</label>
                    <input 
                      type="password"
                      value={discordMusicToken}
                      onChange={e => setDiscordMusicToken(e.target.value)}
                      placeholder="Paste token here..."
                      className="w-full bg-gray-950 border border-gray-800 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-4 py-3 text-sm transition-all"
                    />
                  </div>
                  <button 
                    onClick={handleConnectDiscordMusic}
                    disabled={isDiscordMusicConnecting || !discordMusicToken}
                    className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg px-4 py-3 transition-colors flex items-center justify-center gap-2"
                  >
                    {isDiscordMusicConnecting ? 'Connecting...' : 'Connect to Discord'}
                  </button>
                </div>
              ) : (
                <div className="bg-gray-950 border border-gray-800 rounded-lg p-5 flex flex-col items-center justify-center text-center space-y-4">
                  <Bot className="w-10 h-10 text-emerald-400" />
                  <div>
                    <p className="font-medium text-gray-200">Music Bot Active</p>
                    <p className="text-xs text-gray-500 mt-1">Bot is connected and ready to accept !play chat commands.</p>
                  </div>
                  
                  <div className="w-full pt-4 border-t border-gray-800">
                    <label className="block text-xs font-medium text-gray-400 uppercase tracking-wider mb-2 text-left">Global Volume</label>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-gray-500">0%</span>
                      <input 
                        type="range" 
                        min="0" max="200" 
                        value={globalVolume}
                        className="flex-1 accent-indigo-500"
                        onChange={(e) => {
                          const val = parseInt(e.target.value, 10);
                          setGlobalVolume(val);
                          fetch('/api/discord-music/volume', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ volume: val })
                          }).catch(err => console.error("Failed to update music volume", err));
                        }}
                      />
                      <span className="text-xs text-gray-500">200%</span>
                    </div>
                    <div className="text-xs text-indigo-400 mt-2 font-mono text-center">CURRENT: {globalVolume}%</div>
                  </div>

                  <div className="w-full pt-4 border-t border-gray-800">
                    <label className="block text-xs font-medium text-gray-400 uppercase tracking-wider mb-2 text-left">Help Command Text (/help, /tulong)</label>
                    <textarea 
                      value={musicBotHelpText}
                      onChange={e => setMusicBotHelpText(e.target.value)}
                      className="w-full bg-gray-950 border border-gray-800 focus:border-indigo-500 rounded-lg px-3 py-2 text-sm outline-none h-32 mb-2 resize-none whitespace-pre-wrap"
                    />
                    <button 
                      onClick={handleSaveHelpText}
                      disabled={isSavingHelpText}
                      className="w-full bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white text-xs font-medium py-2 rounded-lg transition-colors border border-gray-700"
                    >
                      {isSavingHelpText ? 'Saving...' : 'Save Help Text'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 flex flex-col justify-between">
            <div>
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-lg font-medium flex items-center gap-2">
                  <Shield className="w-5 h-5 text-indigo-400" /> Discord Connection
                </h2>
                {isDiscordConnected && (
                  <button 
                    onClick={handleDisconnectDiscord}
                    className="text-xs flex items-center gap-1 text-red-400 hover:text-red-300 transition-colors bg-red-400/10 px-2 py-1 rounded"
                  >
                    <Trash2 className="w-3 h-3" /> Disconnect
                  </button>
                )}
              </div>
              <p className="text-sm text-gray-400 mb-6 border-l-2 border-indigo-500/50 pl-3">
                To connect, provide a valid Discord Bot Token. The bot needs the <strong>Message Content Intent</strong> enabled in the developer portal to read standard chat commands like <code>!ss text</code>.
              </p>
              
              {!isDiscordConnected ? (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">Bot Token</label>
                    <input 
                      type="password"
                      value={discordToken}
                      onChange={e => setDiscordToken(e.target.value)}
                      placeholder="Paste token here..."
                      className="w-full bg-gray-950 border border-gray-800 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-4 py-3 text-sm transition-all"
                    />
                  </div>
                  <button 
                    onClick={handleConnectDiscord}
                    disabled={isDiscordConnecting || !discordToken}
                    className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg px-4 py-3 transition-colors flex items-center justify-center gap-2"
                  >
                    {isDiscordConnecting ? 'Connecting...' : 'Connect to Discord'}
                  </button>
                </div>
              ) : (
                <div className="bg-gray-950 border border-gray-800 rounded-lg p-5 flex flex-col items-center justify-center text-center space-y-3">
                  <Bot className="w-10 h-10 text-emerald-400" />
                  <div>
                    <p className="font-medium text-gray-200">Connection Active</p>
                    <p className="text-xs text-gray-500 mt-1">Bot is connected and ready. You can test TTS or use the bot directly via Discord chat.</p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Settings & Voice Test Card */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 flex flex-col h-full space-y-6">
            <div>
              <h2 className="text-lg font-medium flex items-center gap-2 mb-4">
                <Settings className="w-5 h-5 text-indigo-400" /> Voice & Streaming Settings
              </h2>
              <div className="space-y-4">
                <div>
                   <label className="block text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">Language Code</label>
                   <div className="flex gap-2">
                     <select 
                       value={voiceLang}
                       onChange={e => setVoiceLang(e.target.value)}
                       className="flex-1 bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm focus:border-indigo-500 outline-none"
                     >
                       <option value="en-female">English (en-female)</option>
                       <option value="tl-female">Tagalog - Female (tl-female)</option>
                       <option value="tl-male">Tagalog - Male (tl-male)</option>
                       <option value="es">Spanish (es)</option>
                       <option value="pt-br">Portuguese - BR (pt-br)</option>
                       <option value="fr-fr">French (fr)</option>
                       <option value="de-de">German (de)</option>
                       <option value="ja">Japanese (ja)</option>
                     </select>
                     <button 
                       onClick={handleSaveSettings}
                       className="bg-gray-800 hover:bg-gray-700 text-gray-200 px-4 rounded-lg text-sm font-medium transition-colors border border-gray-700"
                     >
                       Save
                     </button>
                   </div>
                   <p className="text-xs text-gray-500 mt-2">Applies to Discord voice transmitter commands as well.</p>
                </div>

                <div className="pt-4 border-t border-gray-800 space-y-2">
                   <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider">YouTube Cookie (Optional)</label>
                   <textarea
                     value={youtubeCookie}
                     onChange={e => setYoutubeCookie(e.target.value)}
                     rows={3}
                     placeholder="Paste full Cookie string (or __Secure-3PSID) to bypass 'Sign in to confirm you're not a bot' error..."
                     className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-xs focus:border-indigo-500 outline-none resize-none font-mono text-gray-300 placeholder:text-gray-600"
                   />
                   <p className="text-[11px] text-gray-500 leading-normal">
                     Supplying YouTube cookies allows play-dl to authenticate calls, securely bypassing standard Bot/Sign-in blockades on your hosting server. Maximize reliability on live environments.
                   </p>
                </div>
              </div>
            </div>

            <div className="pt-6 border-t border-gray-800">
               <h2 className="text-lg font-medium flex items-center gap-2 mb-4">
                <Play className="w-5 h-5 text-indigo-400" /> Quick Transmitter Tester
              </h2>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">Target Channel</label>
                  <select 
                    value={testVoiceChannelId}
                    onChange={(e) => setTestVoiceChannelId(e.target.value)}
                    className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2.5 text-sm focus:border-indigo-500 outline-none"
                    disabled={!isDiscordConnected}
                  >
                    {!isDiscordConnected && <option value="">Connect to Discord first...</option>}
                    {isDiscordConnected && availableChannels.length === 0 && <option value="">No voice channels found...</option>}
                    {availableChannels.map(ch => (
                      <option key={ch.id} value={ch.id}>{ch.guildName} - {ch.name}</option>
                    ))}
                  </select>
                </div>
                
                <div>
                  <label className="block text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">Message</label>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input 
                      type="text" 
                      value={testVoiceText}
                      onChange={e => setTestVoiceText(e.target.value)}
                      placeholder="Type a message to transmit..."
                      className="flex-1 bg-gray-950 border border-gray-800 rounded-lg px-4 py-2.5 text-sm focus:border-indigo-500 outline-none"
                    />
                    <button 
                      onClick={handleTestVoice}
                      disabled={!testVoiceChannelId || !isDiscordConnected}
                      className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-800 disabled:text-gray-500 text-white px-5 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap"
                    >
                      Transmit
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.9 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 pointer-events-none"
          >
            <div className={`px-4 py-3 rounded-lg shadow-xl shadow-black/50 border flex items-center gap-3 backdrop-blur-md ${
              toast.type === 'error' ? 'bg-red-950/90 border-red-900/50 text-red-200' :
              toast.type === 'success' ? 'bg-emerald-950/90 border-emerald-900/50 text-emerald-200' :
              'bg-gray-900/90 border-gray-800 text-gray-200'
            }`}>
              {toast.type === 'error' && <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0" />}
              {toast.type === 'success' && <Shield className="w-5 h-5 text-emerald-400 flex-shrink-0" />}
              <span className="text-sm font-medium">{toast.message}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
