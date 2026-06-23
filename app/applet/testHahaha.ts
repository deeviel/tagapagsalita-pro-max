import * as googleTTS from 'google-tts-api';
import fs from 'fs';

async function run() {
  const texts = [
    'ha ha ha ha',
    'haha haha.',
    'hahahaha',
    'ha, ha, ha, haha'
  ];
  for (let i = 0; i < texts.length; i++) {
    const url = googleTTS.getAudioUrl(texts[i], { lang: 'en-US' });
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(`test_haha_${i}.mp3`, Buffer.from(arrayBuffer));
  }
}
run();
