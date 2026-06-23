import * as playDL from 'play-dl';
const play = playDL.default || playDL;
async function test() {
  try {    
    const stream = await play.stream("https://open.spotify.com/track/0K97VYi5EfyRayXLAz6xni", { quality: 2, discordPlayerCompatibility: true });
    console.log("Keys:", Object.keys(stream));
  } catch (e: any) {
    console.log("Error:", e.message);
  }
}
test();
