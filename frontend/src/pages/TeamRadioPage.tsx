import { useState, useEffect } from 'react';
import { api, type RadioMessage } from '../lib/api';
import { useSessionStore } from '../store/sessionStore';
import { Play, Pause } from 'lucide-react';
import { getDriverColour } from '../lib/colours';

export default function TeamRadioPage() {
  const { activeSessionKey } = useSessionStore();
  const [radios, setRadios] = useState<RadioMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDriver, setSelectedDriver] = useState<string>('ALL');
  const [playingUrl, setPlayingUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!activeSessionKey) return;
    setLoading(true);
    setError(null);
    api.getTeamRadio(activeSessionKey)
      .then(res => setRadios(res.data))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [activeSessionKey]);

  // Extract unique drivers for filter dropdown
  const drivers = Array.from(new Set(radios.map(r => r.driver))).sort();

  const filteredRadios = selectedDriver === 'ALL'
    ? radios
    : radios.filter(r => r.driver === selectedDriver);

  const togglePlay = (url: string) => {
    if (playingUrl === url) {
      setPlayingUrl(null); // Stop playing if clicking the same one
    } else {
      setPlayingUrl(url); // Play new one
    }
  };

  if (!activeSessionKey) {
    return (
      <div style={{ padding: 'var(--space-6)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <h2 style={{ marginBottom: 'var(--space-4)', color: 'var(--text-primary)', fontSize: 'var(--fs-xl)' }}>No Session Selected</h2>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-slate-950 p-6 overflow-hidden">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Team Radio</h1>
          <p className="text-slate-400 text-sm mt-1">Listen to live and archived team radio communications</p>
        </div>
        
        <div className="flex items-center gap-4">
          {drivers.length > 0 && (
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-slate-400 uppercase tracking-wider">Filter Driver:</span>
              <select
                value={selectedDriver}
                onChange={(e) => setSelectedDriver(e.target.value)}
                className="bg-slate-900 border border-slate-700 text-slate-200 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-2"
              >
                <option value="ALL">All Drivers</option>
                {drivers.map(d => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
        {loading ? (
          <div className="flex items-center justify-center h-64 text-slate-400">Loading radio messages...</div>
        ) : error ? (
          <div className="flex items-center justify-center h-64 text-red-400">{error}</div>
        ) : radios.length === 0 ? (
          <div className="flex items-center justify-center h-64 text-slate-500">
            No team radio messages available for this session.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 pb-12">
            {filteredRadios.map((radio, idx) => {
              const driverColor = getDriverColour(radio.driver) || radio.team_color || '#888';
              const isPlaying = playingUrl === radio.audio_url;

              return (
                <div 
                  key={idx}
                  className="bg-slate-900 rounded-xl border border-slate-800 p-4 flex flex-col gap-3 hover:border-slate-700 transition-colors"
                >
                  <div className="flex justify-between items-start">
                    <div className="flex items-center gap-3">
                      <div 
                        className="w-1.5 h-10 rounded-full"
                        style={{ backgroundColor: driverColor }}
                      />
                      <div>
                        <div className="font-bold text-slate-100 text-lg">
                          {radio.driver} <span className="text-slate-500 text-sm font-normal ml-1">#{radio.driver_number}</span>
                        </div>
                        <div className="text-xs text-slate-400 font-mono">
                          {new Date(radio.utc).toLocaleTimeString(undefined, {
                            hour: '2-digit', minute: '2-digit', second: '2-digit'
                          })}
                        </div>
                      </div>
                    </div>
                    
                    <button
                      onClick={() => togglePlay(radio.audio_url)}
                      className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
                        isPlaying ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-500/20' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                      }`}
                    >
                      {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="ml-1" />}
                    </button>
                  </div>

                  {/* Hidden audio element controlled by React state */}
                  {isPlaying && (
                    <audio 
                      src={radio.audio_url} 
                      autoPlay 
                      onEnded={() => setPlayingUrl(null)}
                      className="hidden" 
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
