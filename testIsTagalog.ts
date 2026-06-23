import { isTaglishOrTagalog } from './discordBot';

console.log("Detecting Tagalog 'kamusta po kayo mga bossing':", isTaglishOrTagalog('kamusta po kayo mga bossing'));
console.log("Detecting Tagalog 'ako pala ay may lobo':", isTaglishOrTagalog('ako pala ay may lobo'));
console.log("Detecting English 'hello everyone, have a nice day':", isTaglishOrTagalog('hello everyone, have a nice day'));
