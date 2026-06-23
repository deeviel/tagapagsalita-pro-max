import * as googleTTS from 'google-tts-api';
import fs from 'fs';

async function run() {
  const wordsToTest = ['gago', 'ga go', 'gahgoh', 'gah goh', 'gagu'];
  for (const w of wordsToTest) {
    const url = googleTTS.getAudioUrl(w, {
      lang: 'tl',
      slow: false,
      host: 'https://translate.google.com',
    });
    console.log(w, url);
  }
}
run();
