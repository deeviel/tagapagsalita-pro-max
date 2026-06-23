import * as playDL from 'play-dl';
const play = playDL.default || playDL;
async function test() {
  try {
    const stream = await play.stream("https://www.youtube.com/watch?v=dQw4w9WgXcQ", { discordPlayerCompatibility: true, quality: 2 });
    console.log(stream.type);
  } catch (e: any) {
    console.log("Error:", e.message);
  }
}
test();
