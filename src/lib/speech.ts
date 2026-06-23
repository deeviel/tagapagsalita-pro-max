// Utility for text-to-speech functionality

export interface VoiceOption {
  uri: string;
  name: string;
  lang: string;
}

class SpeechService {
  private synth: SpeechSynthesis | null = null;
  private voice: SpeechSynthesisVoice | null = null;
  public availableVoices: SpeechSynthesisVoice[] = [];
  public voicesLoaded: boolean = false;
  private listeners: (() => void)[] = [];

  constructor() {
    try {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        this.synth = window.speechSynthesis;
        
        const loadVoices = () => {
          try {
            if (!this.synth) return;
            
            // Filter English and Tagalog/Filipino voices to support proper bilingual pronunciation accents
            const rawVoices = this.synth.getVoices() || [];
            this.availableVoices = rawVoices.filter(v => 
              v && v.lang && (
                v.lang.startsWith('en') || 
                v.lang.startsWith('tl') || 
                v.lang.startsWith('fil')
              )
            );

            if (this.availableVoices.length > 0) {
              this.voicesLoaded = true;
              
              let savedUri = null;
              try {
                savedUri = localStorage.getItem('selectedVoiceUri');
              } catch (e) {}

              if (savedUri) {
                const matched = this.availableVoices.find(v => v.voiceURI === savedUri);
                if (matched) {
                  this.voice = matched;
                }
              }

              if (!this.voice) {
                // Prefer a smooth voice if no stored preset
                this.voice = this.availableVoices.find(v => 
                  v.name && (
                    v.name.includes('Google') || 
                    v.name.includes('Samantha') || 
                    v.name.includes('Tessa') ||
                    v.lang.startsWith('tl') ||
                    v.lang.startsWith('fil')
                  )
                ) || this.availableVoices[0];
              }
              
              this.listeners.forEach(cb => {
                try { cb(); } catch (e) {}
              });
            }
          } catch (e) {
            console.warn("speechSynthesis.getVoices error:", e);
          }
        };

        loadVoices();
        if (this.synth && this.synth.onvoiceschanged !== undefined) {
          this.synth.onvoiceschanged = loadVoices;
        }
      }
    } catch (err) {
      console.warn("speechSynthesis initialization blocked or failed:", err);
      this.synth = null;
    }
  }

  subscribe(cb: () => void) {
    this.listeners.push(cb);
    if (this.voicesLoaded) {
      try { cb(); } catch (e) {}
    }
    return () => {
      this.listeners = this.listeners.filter(l => l !== cb);
    };
  }

  onVoicesLoaded(cb: () => void) {
    this.subscribe(cb);
  }

  getVoices(): VoiceOption[] {
    try {
      return this.availableVoices.map(v => ({
        uri: v.voiceURI,
        name: v.name,
        lang: v.lang
      }));
    } catch (e) {
      return [];
    }
  }

  setVoiceByUri(uri: string) {
    try {
      const v = this.availableVoices.find(v => v.voiceURI === uri);
      if (v) this.voice = v;
    } catch (e) {}
  }

  getCurrentVoiceUri(): string | null {
    return this.voice ? this.voice.voiceURI : null;
  }

  speak(text: string, rate: number = 1.0, interrupt: boolean = true) {
    try {
      if (!this.synth) return;

      if (interrupt) {
        this.synth.cancel();
      }

      const utterance = new SpeechSynthesisUtterance(text);
      if (this.voice) {
        utterance.voice = this.voice;
      }
      utterance.rate = rate; // 1.0 is normal speed
      utterance.pitch = 1.0;
      utterance.volume = 1.0;

      this.synth.speak(utterance);
    } catch (e) {
      console.warn("speechSynthesis.speak error:", e);
    }
  }

  cancel() {
    try {
      if (this.synth) {
        this.synth.cancel();
      }
    } catch (e) {
      console.warn("speechSynthesis.cancel error:", e);
    }
  }
}

export const speech = new SpeechService();
