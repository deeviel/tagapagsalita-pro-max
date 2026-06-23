import * as googleTTS from 'google-tts-api';
import fs from 'fs';

async function run() {
  const texts = [
    'argh',
    'arrrgh',
    'ugh',
    'uggh',
    'unngh',
    'oooh'
  ];
  for (let i = 0; i < texts.length; i++) {
    const url = googleTTS.getAudioUrl(texts[i], { lang: 'en-US' });
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(`test_sound_${i}.mp3`, Buffer.from(arrayBuffer));
  }
}
run();
