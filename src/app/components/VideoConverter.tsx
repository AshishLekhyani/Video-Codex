'use client';

import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Shield, 
  Zap, 
  FileVideo, 
  Code, 
  Download, 
  Copy, 
  Lock, 
  Unlock, 
  Monitor, 
  Database, 
  Share2,
  ChevronRight,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Terminal,
  Cpu,
  Layers,
  Sun,
  Moon,
  X,
  Eye,
  EyeOff
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface EncodedData {
  isBinary: boolean;
  compressionMode: string;
  filename: string;
  size: number;
}

export default function VideoConverter() {
  const [mode, setMode] = useState<'encode' | 'decode'>('encode');
  const [compressionMode, setCompressionMode] = useState<'zstd-json' | 'binary' | 'context' | 'lossy'>('zstd-json');
  const [quality, setQuality] = useState(85);
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStep, setProcessingStep] = useState<string>('');
  const [encodedData, setEncodedData] = useState<EncodedData | null>(null);
  const [jsonText, setJsonText] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [isLightMode, setIsLightMode] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sync theme to body
  useEffect(() => {
    if (isLightMode) {
      document.body.classList.add('theme-light');
    } else {
      document.body.classList.remove('theme-light');
    }
  }, [isLightMode]);

  // Simulated Engine Telemetry
  useEffect(() => {
    if (isProcessing) {
      const telemetryInterval = setInterval(() => {
        const events = [
          "Optimizing Zstd window log: 21",
          "Analyzing entropy density...",
          "Mapping ChaCha20-Poly1305 nonce...",
          "Stabilizing bitstream buffers...",
          "Parallelizing HEVC re-encode...",
          "Finalizing VCEO binary header..."
        ];
        const event = events[Math.floor(Math.random() * events.length)];
        setLogs(prev => [...prev.slice(-5), `[${new Date().toLocaleTimeString()}] ${event}`]);
      }, 1200);
      return () => clearInterval(telemetryInterval);
    }
  }, [isProcessing]);

  const validateAndSetFile = (file: File) => {
    setError('');
    setEncodedData(null);
    setJsonText('');
    setLogs([`[SYSTEM] IO: Handshaking file ${file.name}`]);
    
    if (mode === 'encode' && !file.type.startsWith('video/')) {
        setError('Engine requires a valid video stream source');
        return;
    }
    setFile(file);
  };

  const handleConvert = async () => {
    if (!file) return;

    setIsProcessing(true);
    setError('');
    setLogs(prev => [...prev, "[SYSTEM] Booting Studio Engine v5.1 Platinum..."]);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('mode', mode);
      formData.append('compressionMode', compressionMode);
      formData.append('quality', quality.toString());
      if (password) formData.append('password', password);

      setProcessingStep('Compute Allocation...');
      const response = await fetch('/api/convert', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Engine Error');
      }

      if (mode === 'encode') {
        const isBinaryMode = compressionMode === 'binary' || compressionMode === 'context' || compressionMode === 'lossy';
        setProcessingStep('Streaming Bitstream...');
        
        if (isBinaryMode) {
          const blob = await response.blob();
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          const extension = password ? '.vceo.enc' : '.vceo';
          a.download = file.name.replace(/\.[^/.]+$/, '') + extension;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          window.URL.revokeObjectURL(url);
          
          setEncodedData({
            isBinary: true,
            compressionMode,
            filename: file.name,
            size: blob.size,
          });
          setJsonText(`// BINARY VCEO STREAM DELIVERED\n// Mode: ${compressionMode.toUpperCase()}\n// Protection: ${password ? 'ChaCha20-Poly1305' : 'None'}`);
        } else {
          const data = await response.json();
          setEncodedData({
            isBinary: false,
            compressionMode,
            filename: file.name,
            size: JSON.stringify(data.data).length,
          });
          setJsonText(data.jsonText);
        }
      } else {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const contentDisposition = response.headers.get('Content-Disposition');
        let filename = 'decoded_video.mp4';
        if (contentDisposition) {
            const match = contentDisposition.match(/filename="(.+)"/);
            if (match) filename = match[1];
        }
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        setLogs(prev => [...prev, `[SYSTEM] Stream decoupled: ${filename} saved.`]);
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      setError(errorMsg);
      setLogs(prev => [...prev, `[EXCEPTION] ${errorMsg}`]);
    } finally {
      setIsProcessing(false);
      setProcessingStep('');
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(jsonText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden font-sans selection:bg-accent-primary/30">
      <div className="noise" />

      {/* --- SIDEBAR --- */}
      <aside className="w-80 border-r border-foreground/10 bg-surface/40 backdrop-blur-3xl flex flex-col z-30">
        <div className="p-8 border-b border-foreground/10 bg-gradient-to-br from-white/[0.02] to-transparent">
          <div className="flex items-center gap-4 mb-8">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-accent-primary to-accent-secondary p-[1px] shadow-glow">
              <div className="w-full h-full rounded-2xl bg-background flex items-center justify-center">
                <Cpu className="w-6 h-6 text-accent-primary glow-primary" />
              </div>
            </div>
            <div>
              <h1 className="text-sm font-black uppercase tracking-[0.2em] leading-none text-foreground">Studio Engine</h1>
              <p className="text-[10px] font-bold text-foreground/70 tracking-widest mt-1.5 flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                V5.1 PLATINUM
              </p>
            </div>
          </div>

          <div className="flex p-1 bg-background/40 rounded-xl border border-foreground/10">
             {(['encode', 'decode'] as const).map(m => (
               <button
                 key={m}
                 onClick={() => { setMode(m); setFile(null); setEncodedData(null); }}
                 className={cn(
                   "flex-1 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all",
                   mode === m ? "bg-foreground text-background shadow-xl" : "text-foreground/70 hover:text-foreground"
                 )}
               >
                 {m}
               </button>
             ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-8 space-y-10 scrollbar-hide">
          {mode === 'encode' ? (
            <div className="space-y-4">
              <label className="text-[10px] font-black text-foreground/70 uppercase tracking-[0.3em] flex items-center gap-2">
                <Layers className="w-3 h-3 text-accent-primary" /> Processing Profile
              </label>
              <div className="space-y-2">
                {[
                  { id: 'zstd-json', label: 'ZSTD+JSON', desc: 'Human-Readable' },
                  { id: 'binary', label: 'BINARY STREAM', desc: 'Max Efficiency' },
                  { id: 'context', label: 'CONTEXT MODEL', desc: 'High Entropy' },
                  { id: 'lossy', label: 'H.265 LOSSY', desc: 'Studio Compact' }
                ].map(c => (
                    <button
                      key={c.id}
                      onClick={() => setCompressionMode(c.id as 'zstd-json' | 'binary' | 'context' | 'lossy')}
                      className={cn(
                        "w-full flex items-center justify-between p-4 rounded-2xl border transition-all text-left",
                        compressionMode === c.id 
                          ? "bg-foreground/[0.05] border-accent-primary/50 text-foreground" 
                          : "bg-transparent border-foreground/10 text-foreground/70 hover:border-foreground/20 hover:bg-foreground/[0.02]"
                      )}
                    >
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-wider">{c.label}</p>
                      <p className="text-[9px] font-bold text-foreground/60 mt-0.5">{c.desc}</p>
                    </div>
                    {compressionMode === c.id && <div className="w-1.5 h-1.5 rounded-full bg-accent-primary glow-primary shadow-glow" />}
                  </button>
                ))}
              </div>
              
              {compressionMode === 'lossy' && (
                <div className="pt-4 space-y-3">
                  <div className="flex justify-between text-[9px] font-black text-foreground/70 uppercase tracking-widest">
                    <span>Quality Offset</span>
                    <span className="text-accent-primary">{quality}%</span>
                  </div>
                  <input
                    type="range"
                    min="50"
                    max="100"
                    value={quality}
                    onChange={(e) => setQuality(parseInt(e.target.value))}
                    className="w-full h-1 bg-foreground/10 rounded-lg appearance-none cursor-pointer accent-accent-primary"
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <label className="text-[10px] font-black text-foreground/70 uppercase tracking-[0.3em] flex items-center gap-2">
                <Layers className="w-3 h-3 text-accent-secondary" /> Processing Profile
              </label>
              <div className="w-full flex items-center justify-between p-4 rounded-2xl border border-foreground/10 bg-foreground/[0.02] opacity-70">
                 <div>
                    <p className="text-[10px] font-black uppercase tracking-wider text-foreground">AUTO-DETECT</p>
                    <p className="text-[9px] font-bold text-foreground/60 mt-0.5">Demuxing Payload Headers</p>
                 </div>
                 <div className="w-1.5 h-1.5 rounded-full bg-accent-secondary glow-secondary shadow-glow animate-pulse" />
              </div>
            </div>
          )}

          <div className="pt-6 border-t border-foreground/10 space-y-4">
            {[
              { icon: <Monitor className="w-3.5 h-3.5" />, label: "Engine Status", val: isProcessing ? "ACTIVE" : "READY", active: isProcessing },
              { icon: <Database className="w-3.5 h-3.5" />, label: "Cache Layer", val: "L3 / 256MB", active: true },
              { icon: <Zap className="w-3.5 h-3.5" />, label: "Acceleration", val: "NVIDIA/METAL", active: true }
            ].map((stat, i) => (
              <div key={i} className="flex items-center justify-between">
                <span className="text-[9px] font-bold text-foreground/70 flex items-center gap-3 uppercase tracking-widest">
                  <span className={cn("flex items-center justify-center w-6 h-6 rounded-full shrink-0", stat.active ? "text-accent-primary bg-accent-primary/10" : "text-foreground/40 bg-foreground/5")}>{stat.icon}</span>
                  {stat.label}
                </span>
                <span className={cn("text-[9px] font-black tabular-nums", stat.active ? "text-foreground" : "text-foreground/50")}>{stat.val}</span>
              </div>
            ))}
          </div>
        </div>
      </aside>

      {/* --- MAIN STAGE --- */}
      <main className="flex-1 flex flex-col relative z-20 overflow-hidden">
        
        {/* Workspace Toolbar */}
        <header className="h-20 border-b border-foreground/5 flex items-center justify-between px-10 bg-background/50 backdrop-blur-md sticky top-0 z-40">
           <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-foreground/5 border border-foreground/10">
                <span className="text-[10px] font-black text-foreground/70 uppercase tracking-widest leading-none">Workspace: Primary</span>
              </div>
           </div>
           
           <div className="flex items-center gap-4">
              {/* Security Key in Header (V4 Optimization) */}
              <div className="relative w-56 hidden md:block group">
                <div className="absolute inset-y-0 left-3.5 flex items-center pointer-events-none transition-colors group-focus-within:text-accent-primary">
                  {password ? <Lock className="w-3.5 h-3.5" /> : <Shield className="w-3.5 h-3.5 opacity-50" />}
                </div>
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Studio Encryption Key..."
                  className="w-full bg-foreground/5 border border-foreground/10 rounded-2xl py-2.5 pl-10 pr-10 text-[10px] text-foreground focus:outline-none focus:border-accent-primary/20 focus:bg-foreground/10 transition-all font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-foreground/40 hover:text-accent-primary transition-colors focus:outline-none"
                >
                  {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>

              <div className="w-px h-6 bg-foreground/10 mx-1" />

              <button 
                onClick={() => setIsLightMode(!isLightMode)}
                className="w-10 h-10 flex items-center justify-center rounded-2xl text-foreground/50 hover:text-foreground hover:bg-foreground/5 transition-all"
                title="Phase Shift (Theme Toggle)"
              >
                {isLightMode ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
              </button>
              
              <button 
                onClick={() => setShowSettings(true)}
                className="h-10 px-5 rounded-2xl text-[10px] font-black uppercase tracking-widest text-foreground/50 hover:text-foreground hover:bg-foreground/5 transition-all border border-transparent hover:border-foreground/10"
              >
                Studio Settings
              </button>
           </div>
        </header>

        <AnimatePresence>
          {showSettings && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-xl"
            >
              <motion.div 
                initial={{ y: 20, scale: 0.95 }}
                animate={{ y: 0, scale: 1 }}
                exit={{ y: 20, scale: 0.95 }}
                className="w-full max-w-md bg-surface border border-foreground/10 shadow-2xl rounded-[32px] overflow-hidden p-8 relative"
              >
                <button onClick={() => setShowSettings(false)} className="absolute top-6 right-6 text-foreground/40 hover:text-foreground">
                  <X className="w-5 h-5" />
                </button>
                <h3 className="text-xl font-black mb-8 tracking-tighter text-foreground">Studio Defaults</h3>
                
                <div className="space-y-8">
                  <div className="space-y-3">
                     <label className="text-[10px] font-black text-foreground/50 uppercase tracking-[0.2em]">Compute Threads</label>
                     <select className="w-full bg-background/40 border border-foreground/10 rounded-2xl py-3.5 px-5 text-xs font-bold appearance-none text-foreground focus:outline-none focus:border-accent-primary/20">
                       <option>Auto (Hardware Limit)</option>
                       <option>2 Threads</option>
                       <option>4 Threads</option>
                       <option>Max Parallel</option>
                     </select>
                  </div>
                  
                  <div className="space-y-3">
                     <label className="text-[10px] font-black text-foreground/50 uppercase tracking-[0.2em]">Hardware Target</label>
                     <select className="w-full bg-background/40 border border-foreground/10 rounded-2xl py-3.5 px-5 text-xs font-bold appearance-none text-foreground focus:outline-none focus:border-accent-primary/20">
                       <option>Balanced CPU</option>
                       <option>NVIDIA NVENC</option>
                       <option>Apple Metal (M-Series)</option>
                     </select>
                  </div>
                  
                  <button onClick={() => setShowSettings(false)} className="w-full py-4 bg-accent-primary text-background font-black uppercase text-[10px] tracking-widest rounded-2xl shadow-glow transition-transform hover:scale-[1.02] active:scale-95">
                    Update Registry
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex-1 overflow-y-auto p-12 scrollbar-hide">
          <AnimatePresence mode="wait">
            {!file ? (
              <motion.div
                key="empty"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 1.02 }}
                className="h-full flex flex-col items-center justify-center"
              >
                <div 
                  onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={e => { e.preventDefault(); setIsDragging(false); if(e.dataTransfer.files[0]) validateAndSetFile(e.dataTransfer.files[0]); }}
                  onClick={() => fileInputRef.current?.click()}
                  className={cn(
                    "w-full max-w-3xl aspect-video rounded-[64px] border-2 border-dashed flex flex-col items-center justify-center cursor-pointer transition-all duration-700 relative group overflow-hidden bg-surface/20",
                    isDragging ? "border-accent-primary bg-accent-primary/5 scale-[1.01]" : "border-foreground/10 hover:border-foreground/20"
                  )}
                >
                  <input ref={fileInputRef} type="file" accept={mode === 'encode' ? 'video/*' : undefined} className="hidden" onChange={e => { if(e.target.files?.[0]) validateAndSetFile(e.target.files[0]); }} />
                  
                  <motion.div animate={isDragging ? { y: -10 } : { y: 0 }} className="text-center z-10">
                    <div className="w-32 h-32 rounded-[40px] bg-foreground/[0.02] border border-foreground/10 flex items-center justify-center mb-10 mx-auto shadow-[0_0_40px_-15px_var(--glow-primary)] transition-all duration-500 group-hover:scale-105 group-hover:border-foreground/20">
                      {mode === 'encode' ? <FileVideo className="w-12 h-12 text-accent-primary" /> : <Code className="w-12 h-12 text-accent-secondary" />}
                    </div>
                    <h2 className="text-4xl font-black tracking-tighter text-foreground mb-4">Load Engine Payload</h2>
                    <p className="text-foreground/60 font-semibold text-sm tracking-tight">Stream source video or VCEO bitstreams directly</p>
                  </motion.div>
                  
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,var(--glow-primary)_0%,transparent_100%)] opacity-0 group-hover:opacity-[0.05] transition-opacity duration-1000" />
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="active"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="max-w-4xl mx-auto w-full space-y-12 pb-32"
              >
                <div className="p-10 bg-surface/40 backdrop-blur-3xl rounded-[48px] border border-foreground/10 flex items-center justify-between shadow-2xl">
                  <div className="flex items-center gap-8">
                    <div className="w-20 h-20 rounded-[32px] bg-foreground/5 border border-foreground/10 flex items-center justify-center text-accent-primary shadow-glow">
                      {mode === 'encode' ? <FileVideo className="w-10 h-10" /> : <Code className="w-10 h-10 text-accent-secondary" />}
                    </div>
                    <div>
                      <h3 className="text-3xl font-black text-foreground tracking-tighter leading-none">{file.name}</h3>
                      <p className="text-[10px] font-black text-foreground/40 uppercase tracking-[0.3em] mt-3 leading-none">Payload: {(file.size / 1024 / 1024).toFixed(2)} MB • VERIFIED</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => { setFile(null); setEncodedData(null); setError(''); setLogs([]); }}
                    className="h-16 px-10 rounded-[24px] text-[10px] font-black uppercase tracking-[0.2em] text-foreground/40 hover:text-foreground hover:bg-foreground/5 transition-all border border-transparent hover:border-foreground/10"
                  >
                    Detach Source
                  </button>
                </div>

                {error && (
                  <div className="p-10 rounded-[40px] bg-red-500/5 border border-red-500/20 text-red-500 flex items-center gap-8 backdrop-blur-2xl">
                    <AlertCircle className="w-10 h-10 flex-shrink-0" />
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-[0.2em]">Engine Exception</p>
                      <p className="text-sm font-bold mt-2 opacity-80 leading-relaxed">{error}</p>
                    </div>
                  </div>
                )}

                {!encodedData && !error && (
                   <div className="space-y-10">
                     {isProcessing ? (
                       <div className="p-20 bg-surface/50 backdrop-blur-3xl rounded-[64px] border border-foreground/5 text-center space-y-16 relative overflow-hidden shadow-2xl">
                          <div className="relative z-10">
                            <div className="inline-flex items-center gap-4 px-8 py-3 rounded-full bg-accent-primary/5 border border-accent-primary/20 text-accent-primary text-[10px] font-black uppercase tracking-[0.4em] mb-16 animate-pulse">
                              <Loader2 className="w-4 h-4 animate-spin text-accent-primary" /> {processingStep}
                            </div>
                            
                            <div className="max-w-md mx-auto space-y-6">
                              <div className="h-1.5 w-full bg-foreground/5 rounded-full overflow-hidden">
                                <motion.div 
                                  initial={{ width: "0%" }}
                                  animate={{ width: "100%" }}
                                  transition={{ duration: 15, ease: "circIn" }}
                                  className="h-full bg-gradient-to-r from-accent-primary to-accent-secondary shadow-glow"
                                />
                              </div>
                              <div className="flex justify-between text-[9px] font-black text-foreground/30 uppercase tracking-[0.3em] tabular-nums leading-none">
                                 <span>Link: 0x2A</span>
                                 <span>1.2 GB/s Transmit</span>
                              </div>
                            </div>
                          </div>
                       </div>
                     ) : (
                       <button
                         onClick={handleConvert}
                         className="w-full p-10 bg-accent-primary rounded-[48px] text-background flex items-center justify-between group transition-all hover:scale-[1.01] active:shadow-inner shadow-glow"
                       >
                         <div className="flex items-center gap-8 pl-6">
                            <Zap className="w-10 h-10 animate-pulse" />
                            <div className="text-left">
                               <p className="text-[10px] font-black uppercase tracking-[0.4em] leading-none mb-2">Initialize Operation</p>
                               <p className="text-4xl font-black tracking-tighter uppercase leading-none">Execute Studio Codec</p>
                            </div>
                         </div>
                         <div className="w-24 h-24 rounded-full bg-background/20 border border-white/20 flex items-center justify-center mr-2 group-hover:bg-background/30 transition-colors">
                           <ChevronRight className="w-10 h-10" />
                         </div>
                       </button>
                     )}

                     <div className="p-8 bg-background/40 backdrop-blur-2xl rounded-[40px] border border-foreground/5 font-mono shadow-xl text-foreground">
                        <div className="flex items-center gap-3 mb-6 px-4 py-2 bg-foreground/5 w-fit rounded-full border border-foreground/5">
                           <Terminal className="w-3.5 h-3.5 text-accent-primary" />
                           <span className="text-[10px] font-black uppercase tracking-widest text-foreground/50">Telemetry Console</span>
                        </div>
                        <div className="space-y-3 px-4">
                           {logs.length === 0 && <p className="text-[10px] text-foreground/20 italic uppercase tracking-widest">Waiting for compute trigger...</p>}
                           {logs.map((log, i) => (
                             <motion.p 
                               initial={{ opacity: 0, x: -10 }}
                               animate={{ opacity: 1, x: 0 }}
                               key={i} 
                               className="text-[10px] text-foreground/60 leading-none tracking-tight flex items-center gap-3"
                             >
                               <span className="text-accent-primary opacity-50">›</span> {log}
                             </motion.p>
                           ))}
                        </div>
                     </div>
                   </div>
                )}

                {encodedData && (
                  <motion.div 
                    initial={{ scale: 0.95, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="p-10 bg-surface/60 backdrop-blur-3xl rounded-[64px] border border-accent-primary/20 space-y-12 shadow-2xl relative overflow-hidden"
                  >
                    <div className="absolute top-0 right-0 p-10 opacity-5 pointer-events-none text-accent-primary">
                      <CheckCircle2 className="w-48 h-48" />
                    </div>

                    <div className="flex items-center justify-between relative z-10">
                       <div className="text-foreground">
                         <p className="text-[10px] font-black text-accent-primary uppercase tracking-[0.4em] mb-4">Transmission Payload Sealed</p>
                         <h3 className="text-5xl font-black tracking-tighter uppercase leading-none">Result Deliverable</h3>
                       </div>
                       <button
                         onClick={() => { setEncodedData(null); setJsonText(''); }}
                         className="p-4 rounded-2xl hover:bg-foreground/5 transition-colors text-foreground/20 hover:text-foreground/50"
                       >
                         <X className="w-6 h-6" />
                       </button>
                    </div>

                    <div className="grid grid-cols-2 gap-8 relative z-10">
                       {[
                         { label: "Studio Result", val: encodedData.filename },
                         { label: "VCEO Footprint", val: `${(encodedData.size / 1024 / 1024).toFixed(3)} MB` },
                         { label: "Engine Pulse", val: encodedData.compressionMode.toUpperCase() },
                         { label: "Status", val: "LOCKED / CRYPTO-READY" }
                       ].map((item, i) => (
                         <div key={i} className="p-6 bg-background/40 rounded-3xl border border-foreground/5">
                            <p className="text-[9px] font-black text-foreground/30 uppercase tracking-widest mb-2 leading-none">{item.label}</p>
                            <p className="text-sm font-black text-foreground leading-none">{item.val}</p>
                         </div>
                       ))}
                    </div>

                    <div className="space-y-6 relative z-10">
                      <div className="flex items-center justify-between px-4">
                        <span className="text-[10px] font-black uppercase tracking-widest text-foreground/40">Entropy Bitstream</span>
                        <button onClick={copyToClipboard} className="flex items-center gap-2 text-[10px] font-black uppercase text-accent-primary hover:glow-primary transition-all">
                           {copied ? 'Captured' : 'Capture Bitstream'} <Copy className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="bg-black/40 rounded-[32px] p-8 border border-white/5 max-h-60 overflow-y-auto scrollbar-hide font-mono group">
                        <pre className="text-[11px] text-accent-primary/80 leading-relaxed whitespace-pre-wrap break-all group-hover:text-accent-primary transition-colors">
                          {jsonText}
                        </pre>
                      </div>
                    </div>
                  </motion.div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}
