import { useState, useEffect } from 'react';
import { api, type RadioMessage } from '../../lib/api';
import { Play, Pause } from 'lucide-react';
import { getDriverColour } from '../../lib/colours';
import { useNavigate } from 'react-router-dom';
import { registerPanel, type PanelProps } from '../../core/panelRegistry';

export default function TeamRadioPanel({ sessionKey }: PanelProps) {
  const [radios, setRadios] = useState<RadioMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playingUrl, setPlayingUrl] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!sessionKey) return;
    setLoading(true);
    setError(null);
    api.getTeamRadio(sessionKey)
      .then(res => setRadios(res.data))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [sessionKey]);

  const togglePlay = (url: string) => {
    if (playingUrl === url) {
      setPlayingUrl(null);
    } else {
      setPlayingUrl(url);
    }
  };

  // Only show the latest 20 in the panel
  const recentRadios = radios.slice(0, 20);

  if (loading) {
    return <div className="flex items-center justify-center h-full text-slate-400">Loading...</div>;
  }

  if (error) {
    return <div className="flex items-center justify-center h-full text-red-400 p-2 text-center text-sm">{error}</div>;
  }

  if (recentRadios.length === 0) {
    return <div className="flex items-center justify-center h-full text-slate-500 text-sm">No radio available.</div>;
  }

  return (
    <div className="flex flex-col h-full bg-slate-900 overflow-hidden">
      <div className="flex justify-between items-center p-2 bg-slate-800 border-b border-slate-700">
        <button 
          className="btn btn--outline" 
          style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px' }}
          onClick={() => navigate('/team-radio')}
          title="Open Full Page Analysis"
        >
          ⤢ Expand
        </button>
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-2">
        {recentRadios.map((radio, idx) => {
          const driverColor = getDriverColour(radio.driver) || radio.team_color || '#888';
          const isPlaying = playingUrl === radio.audio_url;

          return (
            <div 
              key={idx}
              className="bg-slate-950 rounded-lg border border-slate-800 p-3 flex justify-between items-center hover:border-slate-700 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div 
                  className="w-1 h-8 rounded-full"
                  style={{ backgroundColor: driverColor }}
                />
                <div>
                  <div className="font-bold text-slate-200 text-sm">
                    {radio.driver} <span className="text-slate-500 text-xs font-normal">#{radio.driver_number}</span>
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono">
                    {new Date(radio.utc).toLocaleTimeString(undefined, {
                      hour: '2-digit', minute: '2-digit', second: '2-digit'
                    })}
                  </div>
                </div>
              </div>
              
              <button
                onClick={() => togglePlay(radio.audio_url)}
                className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                  isPlaying ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-md shadow-blue-500/20' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                }`}
              >
                {isPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" className="ml-0.5" />}
              </button>

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
    </div>
  );
}

// Register the panel in the registry
registerPanel({
  id: 'team-radio',
  title: 'Team Radio',
  category: 'session',
  Component: TeamRadioPanel,
});
