
import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from '@google/genai';
import { ComplaintData, TranscriptionItem } from './types';
import { decode, decodeAudioData, createPcmBlob } from './utils/audioUtils';

const HELPLINE_NUMBER = "1800-VMC-VANI";

const SYSTEM_INSTRUCTION = `
You are VaniAI, a next-generation Multilingual AI Voice Assistant for Vadodara Municipal Corporation (VMC).

PROTOCOL:
1. GREETING: "Welcome to the VaniAI Digital Helpline. For Hindi, press 1 or say Hindi. For English, press 2 or say English. For Gujarati, press 3 or say Gujarati."
2. SELECTION: Switch immediately to the chosen language.
3. DATA GATHERING:
   - Listen for the complaint details (e.g., Street Light, Water Leak, Garbage).
   - Identify Ward (1-19) and Zone (North, South, East, West).
   - If information is missing, ask politely.
4. REGISTRATION: Call 'register_complaint'. 
   - IMPORTANT: After calling the function, inform the user: "Your complaint is registered with ID: [ID]. Please note this for your records."
5. ITERATION: Ask "Would you like to register another complaint or do you need help with anything else?"
6. CLOSURE: If the user says "No" or "That's all", say "Thank you for contacting VMC. We are working to make Vadodara better. Goodbye." then call 'disconnect_call'.

TONE: Advanced, professional, and efficient.
`;

const registerComplaintFn: FunctionDeclaration = {
  name: 'register_complaint',
  parameters: {
    type: Type.OBJECT,
    description: 'Registers the complaint into the central VMC government database.',
    properties: {
      complaintType: { type: Type.STRING, description: 'The category of the issue' },
      wardNumber: { type: Type.STRING, description: 'VMC Ward No (1-19)' },
      zone: { type: Type.STRING, description: 'North, South, East, West' },
      description: { type: Type.STRING, description: 'Brief summary of the issue' },
      language: { type: Type.STRING, description: 'Interaction language' }
    },
    required: ['complaintType', 'description', 'language']
  }
};

const disconnectCallFn: FunctionDeclaration = {
  name: 'disconnect_call',
  parameters: {
    type: Type.OBJECT,
    description: 'Ends the call gracefully after the user is finished.',
    properties: {}
  }
};

// Fix: Added missing helper function to format seconds to MM:SS
const formatTime = (seconds: number) => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

const App: React.FC = () => {
  const [activeCall, setActiveCall] = useState(false);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'records' | 'logs'>('dashboard');
  const [transcriptions, setTranscriptions] = useState<TranscriptionItem[]>([]);
  const [dbComplaints, setDbComplaints] = useState<ComplaintData[]>([]);
  const [logs, setLogs] = useState<string[]>(["VaniAI Quantum Kernel Online."]);
  const [callDuration, setCallDuration] = useState(0);
  
  const audioContextsRef = useRef<{ input: AudioContext; output: AudioContext } | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);

  // Stats calculation for the dashboard
  const stats = useMemo(() => ({
    total: dbComplaints.length,
    resolved: dbComplaints.filter(c => c.status === 'Resolved').length,
    gujarati: dbComplaints.filter(c => c.language.toLowerCase().includes('guj')).length,
    efficiency: "98.2%"
  }), [dbComplaints]);

  useEffect(() => {
    const saved = localStorage.getItem('vaniai_v3_db');
    if (saved) setDbComplaints(JSON.parse(saved));
  }, []);

  useEffect(() => {
    if (activeCall) {
      timerRef.current = window.setInterval(() => setCallDuration(d => d + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      setCallDuration(0);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [activeCall]);

  const addLog = (msg: string) => setLogs(prev => [msg, ...prev.slice(0, 20)]);

  const stopCall = useCallback(async () => {
    setActiveCall(false);
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch (e) {}
      sessionRef.current = null;
    }
    sourcesRef.current.forEach(s => { try { s.stop(); } catch (e) {} });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (audioContextsRef.current) {
      try {
        await audioContextsRef.current.input.close();
        await audioContextsRef.current.output.close();
      } catch (e) {}
      audioContextsRef.current = null;
    }
    addLog("Session safely terminated.");
  }, []);

  const startCall = async () => {
    try {
      await stopCall();
      setActiveCall(true);
      setTranscriptions([]);
      addLog("Initializing Neural Audio Link...");

      const inputAudioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputAudioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      await inputAudioCtx.resume();
      await outputAudioCtx.resume();
      audioContextsRef.current = { input: inputAudioCtx, output: outputAudioCtx };

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          tools: [{ functionDeclarations: [registerComplaintFn, disconnectCallFn] }],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
          }
        },
        callbacks: {
          onopen: () => {
            addLog("Uplink Active. Running IVR Welcome Protocol.");
            const source = inputAudioCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              sessionPromise.then(session => {
                if (sessionRef.current === session) session.sendRealtimeInput({ media: pcmBlob });
              }).catch(() => {});
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              setTranscriptions(prev => {
                const last = prev[prev.length - 1];
                if (last && last.sender === 'user') {
                  const newArr = [...prev];
                  newArr[newArr.length - 1] = { ...last, text: last.text + text };
                  return newArr;
                }
                return [...prev, { id: Date.now().toString(), sender: 'user', text, timestamp: new Date() }];
              });
            }
            if (message.serverContent?.outputTranscription) {
              const text = message.serverContent.outputTranscription.text;
              setTranscriptions(prev => {
                const last = prev[prev.length - 1];
                if (last && last.sender === 'ai') {
                  const newArr = [...prev];
                  newArr[newArr.length - 1] = { ...last, text: last.text + text };
                  return newArr;
                }
                return [...prev, { id: Date.now().toString(), sender: 'ai', text, timestamp: new Date() }];
              });
            }
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && outputAudioCtx) {
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputAudioCtx.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), outputAudioCtx, 24000, 1);
              const source = outputAudioCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputAudioCtx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
              source.onended = () => sourcesRef.current.delete(source);
            }
            if (message.toolCall) {
              for (const fc of message.toolCall.functionCalls) {
                if (fc.name === 'register_complaint') {
                  const args = fc.args as any;
                  const callId = `VMC-${Math.floor(100000 + Math.random() * 900000)}`;
                  const newComplaint: ComplaintData = {
                    id: callId,
                    callReference: callId,
                    timestamp: new Date().toLocaleString(),
                    complaintType: args.complaintType || 'Uncategorized',
                    description: args.description || '',
                    wardNumber: args.wardNumber || 'N/A',
                    zone: args.zone || 'N/A',
                    language: args.language || 'Detected',
                    status: 'Registered'
                  };
                  setDbComplaints(prev => {
                    const updated = [newComplaint, ...prev];
                    localStorage.setItem('vaniai_v3_db', JSON.stringify(updated));
                    return updated;
                  });
                  addLog(`Integrated Record Created: ${callId}`);
                  sessionPromise.then(session => {
                    session.sendToolResponse({
                      functionResponses: {
                        id: fc.id,
                        name: fc.name,
                        response: { result: "Success. Reference ID provided to user is " + callId }
                      }
                    });
                  });
                } else if (fc.name === 'disconnect_call') {
                  addLog("User requested closure. Ending call.");
                  setTimeout(stopCall, 2000);
                }
              }
            }
            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => addLog(`Link Error: ${e.message}`),
          onclose: () => setActiveCall(false)
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      addLog(`Gateway Refused: ${err.message}`);
      setActiveCall(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0F172A] flex flex-col font-sans text-slate-200 overflow-hidden relative">
      
      {/* Background Glows */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-indigo-600/20 blur-[120px] pointer-events-none rounded-full"></div>
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-600/10 blur-[120px] pointer-events-none rounded-full"></div>

      {/* Futuristic Header */}
      <header className="px-8 pt-10 pb-6 flex items-center justify-between z-20">
        <div className="flex items-center space-x-4">
          <div className="w-12 h-12 bg-gradient-to-tr from-indigo-500 to-purple-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-black text-white tracking-tighter leading-none">VaniAI <span className="text-indigo-400 font-normal">OS</span></h1>
            <p className="text-[9px] font-bold text-slate-500 uppercase tracking-[0.4em] mt-1">Multi-Agent Civic Intelligence</p>
          </div>
        </div>
        
        <div className="flex items-center space-x-4">
          <div className="hidden md:flex flex-col items-end mr-6">
            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Digital Gateway</p>
            <p className="text-lg font-mono font-bold text-indigo-400">1800-VMC-VANI</p>
          </div>
          <button 
            onClick={activeCall ? stopCall : startCall}
            className={`group relative px-8 py-3 rounded-xl font-black transition-all overflow-hidden ${
              activeCall ? 'bg-red-500/10 text-red-500 border border-red-500/50' : 'bg-indigo-600 text-white shadow-xl shadow-indigo-500/20'
            }`}
          >
            <span className="relative z-10 flex items-center space-x-2">
               {activeCall ? (
                 <>
                   <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse"></span>
                   <span>TERMINATE</span>
                 </>
               ) : (
                 <>
                   <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>
                   <span>INITIATE LINK</span>
                 </>
               )}
            </span>
          </button>
        </div>
      </header>

      {/* Call UI Component (Full Screen Portal) */}
      {activeCall && (
        <div className="fixed inset-0 z-50 bg-[#0F172A] flex flex-col items-center justify-between py-20 px-8 animate-in fade-in duration-500">
          <div className="text-center space-y-2">
            <div className="inline-flex items-center space-x-2 px-4 py-1.5 bg-indigo-500/10 border border-indigo-500/30 rounded-full text-indigo-400 text-[10px] font-black uppercase tracking-[0.2em] mb-4">
               <span className="w-2 h-2 bg-indigo-500 rounded-full animate-ping"></span>
               <span>Neural Audio Session</span>
            </div>
            <h2 className="text-5xl font-black text-white tracking-tighter">VaniAI Assistant</h2>
            <p className="text-slate-500 font-mono text-xl">{formatTime(callDuration)}</p>
          </div>

          <div className="relative group">
            {/* Pulsing AI Core */}
            <div className="absolute inset-0 bg-indigo-500/20 rounded-full blur-3xl animate-pulse scale-150"></div>
            <div className="w-64 h-64 rounded-full border border-white/10 p-2 flex items-center justify-center bg-slate-800/50 backdrop-blur-xl shadow-2xl overflow-hidden">
               <div className="flex items-center space-x-2 h-20">
                  {[...Array(12)].map((_, i) => (
                    <div 
                      key={i} 
                      className="w-1.5 bg-gradient-to-t from-indigo-500 to-purple-400 rounded-full animate-ai-wave" 
                      style={{ animationDelay: `${i * 0.1}s`, height: `${Math.random() * 60 + 20}%` }}
                    ></div>
                  ))}
               </div>
               <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/5 to-transparent pointer-events-none"></div>
            </div>
          </div>

          <div className="w-full max-w-2xl bg-white/5 border border-white/10 rounded-[2.5rem] p-8 backdrop-blur-2xl">
            <div className="flex justify-between items-center mb-4">
              <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Active Intelligence Stream</span>
              <span className="text-[10px] font-mono text-indigo-400">GEMINI-2.5-NATIVE</span>
            </div>
            <div className="h-32 overflow-y-auto space-y-4 custom-scrollbar pr-4">
              {transcriptions.length === 0 ? (
                <p className="text-slate-500 italic text-center text-sm py-4">Waiting for citizen input...</p>
              ) : (
                transcriptions.slice(-3).map(t => (
                  <div key={t.id} className={`flex ${t.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[85%] px-4 py-2 rounded-2xl ${t.sender === 'user' ? 'bg-indigo-500/20 text-indigo-200' : 'bg-white/10 text-white'}`}>
                      <p className="text-[8px] font-black uppercase opacity-50 mb-1">{t.sender === 'user' ? 'Citizen' : 'VaniAI'}</p>
                      <p className="text-sm font-medium">{t.text}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <button 
            onClick={stopCall}
            className="w-20 h-20 bg-red-500 rounded-full flex items-center justify-center shadow-[0_0_50px_rgba(239,68,68,0.4)] hover:scale-110 active:scale-95 transition-all"
          >
            <svg className="w-10 h-10 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
            </svg>
          </button>
        </div>
      )}

      {/* Main Dashboard Layout */}
      <main className="flex-1 p-8 grid grid-cols-1 lg:grid-cols-12 gap-8 z-10 max-w-[1600px] mx-auto w-full overflow-y-auto pb-32">
        
        {/* Left Stats & Analytics Column */}
        <div className="lg:col-span-4 space-y-8">
           <div className="bg-slate-800/40 border border-white/5 backdrop-blur-xl rounded-[2.5rem] p-8 space-y-8">
              <h3 className="text-sm font-black text-indigo-400 uppercase tracking-[0.3em]">Project Metrics</h3>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-white/5 p-6 rounded-3xl border border-white/5">
                  <p className="text-3xl font-black text-white">{stats.total}</p>
                  <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mt-1">Total Cases</p>
                </div>
                <div className="bg-white/5 p-6 rounded-3xl border border-white/5">
                  <p className="text-3xl font-black text-indigo-400">{stats.efficiency}</p>
                  <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mt-1">AI Efficiency</p>
                </div>
                <div className="bg-white/5 p-6 rounded-3xl border border-white/5">
                  <p className="text-3xl font-black text-green-400">{stats.gujarati}</p>
                  <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mt-1">Gujarati Cases</p>
                </div>
                <div className="bg-white/5 p-6 rounded-3xl border border-white/5">
                  <p className="text-3xl font-black text-purple-400">19</p>
                  <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mt-1">Active Wards</p>
                </div>
              </div>

              <div className="p-6 bg-gradient-to-br from-indigo-600/20 to-purple-600/20 rounded-3xl border border-indigo-500/20">
                 <h4 className="text-xs font-black text-indigo-300 uppercase mb-4 tracking-widest">Global Language Logic</h4>
                 <div className="flex justify-between items-center mb-2">
                    <span className="text-[10px] font-bold text-slate-400 uppercase">Acoustic Dialect Optimization</span>
                    <span className="text-[10px] font-black text-indigo-400">ENABLED</span>
                 </div>
                 <div className="w-full bg-slate-900/50 h-2 rounded-full overflow-hidden">
                    <div className="h-full bg-indigo-500 animate-pulse w-[94%]"></div>
                 </div>
              </div>
           </div>

           <div className="bg-slate-900/80 rounded-[2.5rem] p-8 border border-white/5 font-mono text-[11px] h-[300px] flex flex-col shadow-2xl">
              <div className="flex justify-between items-center mb-6">
                <span className="text-indigo-400 font-black tracking-widest uppercase">System Execution Terminal</span>
                <span className="w-2 h-2 bg-green-500 rounded-full"></span>
              </div>
              <div className="flex-1 overflow-y-auto space-y-2 custom-scrollbar-dark flex flex-col-reverse">
                {logs.map((log, i) => (
                  <div key={i} className="flex space-x-3 border-l border-indigo-500/30 pl-3">
                    <span className="text-slate-600 text-[9px]">{new Date().toLocaleTimeString()}</span>
                    <span className={log.includes('Created') ? 'text-green-400' : 'text-slate-400'}>{log}</span>
                  </div>
                ))}
              </div>
           </div>
        </div>

        {/* Right Data Explorer Column */}
        <div className="lg:col-span-8 flex flex-col space-y-8">
           
           {/* Navigation Tabs */}
           <div className="flex items-center space-x-4">
              {['dashboard', 'records', 'logs'].map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab as any)}
                  className={`px-8 py-3 rounded-2xl font-black text-[11px] uppercase tracking-[0.2em] transition-all border ${
                    activeTab === tab 
                      ? 'bg-indigo-600 text-white border-indigo-500 shadow-xl shadow-indigo-600/20' 
                      : 'bg-white/5 text-slate-500 border-white/5 hover:bg-white/10'
                  }`}
                >
                  {tab}
                </button>
              ))}
           </div>

           {/* Content View */}
           <div className="flex-1 min-h-[600px]">
              {activeTab === 'dashboard' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 animate-in slide-in-from-bottom-6 duration-700">
                   <div className="bg-slate-800/40 p-8 rounded-[2.5rem] border border-white/5 flex flex-col items-center justify-center text-center space-y-6">
                      <div className="w-24 h-24 bg-white/5 rounded-full flex items-center justify-center border border-white/10">
                        <svg className="w-10 h-10 text-indigo-400" fill="currentColor" viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
                      </div>
                      <div>
                        <h4 className="text-xl font-black text-white">Smart Citizen Portal</h4>
                        <p className="text-slate-500 text-sm mt-2 leading-relaxed">Multilingual voice interaction captures complaints across 3 languages with zero wait time.</p>
                      </div>
                      <button onClick={startCall} className="px-10 py-4 bg-indigo-600 rounded-2xl font-black tracking-widest text-[11px] shadow-lg hover:scale-105 transition-all">START TEST SIMULATION</button>
                   </div>

                   <div className="bg-indigo-600/10 p-8 rounded-[2.5rem] border border-indigo-500/20 flex flex-col items-center justify-center text-center space-y-6 relative overflow-hidden">
                      <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/10 blur-3xl rounded-full"></div>
                      <div className="w-24 h-24 bg-indigo-500/20 rounded-full flex items-center justify-center border border-indigo-500/30">
                        <svg className="w-10 h-10 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>
                      </div>
                      <div>
                        <h4 className="text-xl font-black text-white">VMC Integration Logic</h4>
                        <p className="text-slate-400 text-sm mt-2 leading-relaxed">Direct API mapping to existing government grievance software.</p>
                      </div>
                   </div>
                </div>
              )}

              {activeTab === 'records' && (
                <div className="bg-slate-800/40 rounded-[2.5rem] border border-white/5 overflow-hidden animate-in fade-in duration-500">
                   <div className="p-8 border-b border-white/5 flex justify-between items-center">
                      <h4 className="text-lg font-black text-white">Live Database View</h4>
                      <button onClick={() => { localStorage.removeItem('vaniai_v3_db'); setDbComplaints([]); }} className="text-[10px] font-black text-red-400 uppercase tracking-widest hover:text-red-300">Purge Data</button>
                   </div>
                   <div className="overflow-x-auto">
                     <table className="w-full text-left">
                       <thead className="bg-white/5 text-[9px] uppercase font-black text-slate-500 tracking-[0.2em] border-b border-white/5">
                         <tr>
                           <th className="px-8 py-5">Call Ref</th>
                           <th className="px-8 py-5">Category</th>
                           <th className="px-8 py-5">Location</th>
                           <th className="px-8 py-5">Status</th>
                         </tr>
                       </thead>
                       <tbody className="divide-y divide-white/5">
                         {dbComplaints.length === 0 ? (
                           <tr><td colSpan={4} className="px-8 py-20 text-center text-slate-500 font-bold italic">No records found. Link the AI to begin.</td></tr>
                         ) : (
                           dbComplaints.map(c => (
                             <tr key={c.id} className="hover:bg-white/5 transition-all group">
                               <td className="px-8 py-6">
                                 <span className="text-xs font-black text-indigo-400 font-mono tracking-tighter">{c.id}</span>
                                 <p className="text-[9px] text-slate-500 mt-1 font-bold">{c.timestamp}</p>
                               </td>
                               <td className="px-8 py-6">
                                 <p className="text-xs font-black text-slate-200 uppercase">{c.complaintType}</p>
                                 <p className="text-[10px] text-slate-500 font-medium italic mt-1 max-w-xs truncate">"{c.description}"</p>
                               </td>
                               <td className="px-8 py-6">
                                 <p className="text-xs font-bold text-slate-300">Ward {c.wardNumber}</p>
                                 <p className="text-[9px] text-indigo-500/70 font-black uppercase tracking-widest mt-0.5">{c.zone} Zone</p>
                               </td>
                               <td className="px-8 py-6">
                                 <span className="px-3 py-1 bg-green-500/10 text-green-400 border border-green-500/30 rounded-full text-[9px] font-black uppercase">
                                   {c.status}
                                 </span>
                               </td>
                             </tr>
                           ))
                         )}
                       </tbody>
                     </table>
                   </div>
                </div>
              )}
           </div>
        </div>
      </main>

      {/* Futuristic Floating Footer */}
      <footer className="fixed bottom-8 left-1/2 -translate-x-1/2 bg-slate-800/60 backdrop-blur-3xl border border-white/10 px-10 py-4 rounded-[2rem] shadow-2xl z-40 hidden lg:flex items-center space-x-12">
        <div className="flex items-center space-x-3">
           <div className="w-2 h-2 bg-green-500 rounded-full"></div>
           <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Active Core</span>
        </div>
        <div className="h-4 w-px bg-white/10"></div>
        <p className="text-[10px] font-black text-indigo-400 uppercase tracking-widest">Training Accuracy: 96.4%</p>
        <div className="h-4 w-px bg-white/10"></div>
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Vadodara Municipal Project Display v3.0</p>
      </footer>

      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes ai-wave {
          0%, 100% { transform: scaleY(1); opacity: 0.3; }
          50% { transform: scaleY(1.8); opacity: 1; }
        }
        .animate-ai-wave { animation: ai-wave 1s ease-in-out infinite; }
        .custom-scrollbar::-webkit-scrollbar { width: 5px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.05); border-radius: 10px; }
        .custom-scrollbar-dark::-webkit-scrollbar { width: 3px; }
        .custom-scrollbar-dark::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 10px; }
      `}} />
    </div>
  );
};

export default App;
