import { Client, GatewayIntentBits } from 'discord.js';
import { 
  joinVoiceChannel, 
  createAudioPlayer, 
  createAudioResource, 
  AudioPlayerStatus,
  VoiceConnectionStatus,
  getVoiceConnection,
  entersState,
  StreamType
} from '@discordjs/voice';
import * as playDL from 'play-dl';

let playDlInstance: any = playDL;
if (!playDlInstance || typeof playDlInstance.validate !== 'function') {
  playDlInstance = (playDL as any).default || playDL;
}
if (!playDlInstance || typeof playDlInstance.validate !== 'function') {
  playDlInstance = (playDlInstance as any).default || playDlInstance;
}
import dns from 'dns';

interface SpotifyScrapedTrack {
  title: string;
  artist: string;
  searchQuery: string;
}

interface SpotifyScrapedResult {
  type: 'track' | 'playlist' | 'album';
  title: string;
  tracks: SpotifyScrapedTrack[];
}

export async function scrapeSpotifyEmbed(spotifyUrl: string): Promise<SpotifyScrapedResult> {
  let embedUrl = spotifyUrl;
  if (spotifyUrl.includes('open.spotify.com')) {
    embedUrl = spotifyUrl.replace('open.spotify.com/', 'open.spotify.com/embed/');
  }

  // Clear query parameters
  const urlObj = new URL(embedUrl);
  urlObj.search = '';
  embedUrl = urlObj.toString();

  const res = await fetch(embedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch Spotify embed page: Status ${res.status}`);
  }

  const html = await res.text();
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  
  if (!nextDataMatch) {
    throw new Error("Could not find __NEXT_DATA__ payload in Spotify embed page HTML");
  }

  const payload = JSON.parse(nextDataMatch[1]);
  const entity = payload.props?.pageProps?.state?.data?.entity;

  if (!entity) {
    throw new Error("Could not extract entity from Spotify embed payload");
  }

  const entityType = entity.type; // 'track', 'playlist', 'album'
  const title = entity.title || entity.name || "Spotify Collection";

  const tracks: SpotifyScrapedTrack[] = [];

  if (entityType === 'track') {
    const artists = entity.artists ? entity.artists.map((a: any) => a.name).join(' ') : '';
    tracks.push({
      title: title,
      artist: artists,
      searchQuery: `${title} ${artists}`.trim()
    });
  } else if (entityType === 'playlist' || entityType === 'album') {
    const list = entity.trackList || entity.tracks || [];
    for (const item of list) {
      const songTitle = item.title || item.name || "Spotify Track";
      const artist = item.subtitle || (item.artists ? item.artists.map((a: any) => a.name).join(' ') : '');
      tracks.push({
        title: songTitle,
        artist: artist,
        searchQuery: `${songTitle} ${artist}`.trim()
      });
    }
  } else {
    throw new Error(`Unsupported entity type: ${entityType}`);
  }

  return {
    type: entityType,
    title: title,
    tracks: tracks
  };
}

if (dns && typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

let client: Client | null = null;
const activeGuildIds = new Set<string>();

export function debugLog(message: string) {
  const timestamp = new Date().toISOString();
  console.log(`[Discord Music Bot ${timestamp}] ${message}`);
}

export async function applyYoutubeCookie(cookieString: string) {
  if (!cookieString || typeof cookieString !== 'string') return;
  try {
    debugLog("Setting YouTube cookie for play-dl instance...");
    await playDlInstance.setToken({
      youtube: {
        cookie: cookieString.trim()
      }
    });
    debugLog("Successfully applied play-dl YouTube credentials.");
  } catch (err: any) {
    debugLog(`Failed to set play-dl token: ${err.message || err}`);
  }
}

const guildPlayers = new Map<string, any>();
const guildAudioQueues = new Map<string, any[]>();
const guildAudioPlayState = new Map<string, boolean>();
const guildVolumes = new Map<string, number>();
const guildActivePlayingResource = new Map<string, any>();
const guildActiveTextChannels = new Map<string, any>();
const guildDisconnectTimeouts = new Map<string, NodeJS.Timeout>();

let customHelpText = `**🎵 Music Bot Commands:**
\`play <query/url>\` or \`p <query/url>\` - Play a song or add it to the queue
\`skip\` or \`s\` - Skip the currently playing song
\`queue\` or \`q\` - View the upcoming songs in the queue
\`volume <1-200>\` or \`v <1-200>\` - Adjust player playback volume
\`help\`, \`tulong\` or \`h\` - Show this help menu

**Supported Sources:**
- **YouTube** (Videos, Playlists, Search)
- **Spotify** (Tracks, Albums, Playlists)
- **SoundCloud** (Tracks, Playlists, Stream)
- **Deezer** (Tracks, Albums, Playlists)`;

export function getCustomHelpText() {
  return customHelpText;
}

export function setCustomHelpText(text: string) {
  customHelpText = text;
}

export function resetDisconnectTimeout(guildId: string) {
  if (guildDisconnectTimeouts.has(guildId)) {
    clearTimeout(guildDisconnectTimeouts.get(guildId)!);
    guildDisconnectTimeouts.delete(guildId);
  }
}

export function startDisconnectTimeout(guildId: string) {
  resetDisconnectTimeout(guildId);
  debugLog(`Starting 5-minute music bot inactivity disconnect timer for guild ${guildId}`);
  const timeout = setTimeout(() => {
    debugLog(`Inactivity timeout reached: Disconnecting music bot from guild ${guildId}`);
    try {
      const connection = getVoiceConnection(guildId);
      if (connection) {
        connection.destroy();
      }
    } catch (e: any) {
      debugLog(`Error disconnecting music bot on inactivity: ${e.message}`);
    }
    guildPlayers.delete(guildId);
    guildAudioQueues.delete(guildId);
    guildAudioPlayState.delete(guildId);
    activeGuildIds.delete(guildId);
    guildDisconnectTimeouts.delete(guildId);
  }, 5 * 60 * 1000); // 5 minutes
  guildDisconnectTimeouts.set(guildId, timeout);
}

export function getOrCreateMusicGuildPlayer(guildId: string, connection: any) {
  let player = guildPlayers.get(guildId);
  if (!player) {
    player = createAudioPlayer();
    guildPlayers.set(guildId, player);
    
    player.on('error', (error: any) => {
      debugLog(`Persistent Player error on guild ${guildId}: ${error.message}`);
    });

    player.on(AudioPlayerStatus.Idle, () => {
      guildActivePlayingResource.delete(guildId);
      guildAudioPlayState.set(guildId, false);
      const queue = guildAudioQueues.get(guildId);
      if (!queue || queue.length === 0) {
        startDisconnectTimeout(guildId);
      } else {
        playNextInGuildQueue(guildId, player);
      }
    });
  }
  connection.subscribe(player);
  return player;
}

function playNextInGuildQueue(guildId: string, player: any) {
  if (guildAudioPlayState.get(guildId)) return; 

  const queue = guildAudioQueues.get(guildId);
  if (!queue || queue.length === 0) {
    startDisconnectTimeout(guildId);
    return;
  }

  resetDisconnectTimeout(guildId);

  const nextItem = queue.shift();
  if (!nextItem) return;

  guildAudioPlayState.set(guildId, true);
  try {
    let resolvedUrl = nextItem.url;
    let title = nextItem.title;

    (async () => {
      try {
        if (nextItem.searchQuery) {
          debugLog(`Searching YouTube for Spotify track: "${title}" via: "${nextItem.searchQuery}"`);
          const searchResults = await playDlInstance.search(nextItem.searchQuery, { limit: 1 });
          if (searchResults && searchResults.length > 0) {
            resolvedUrl = searchResults[0].url;
            title = searchResults[0].title || title;
          } else {
            throw new Error(`Failed to map Spotify track "${title}" to YouTube.`);
          }
        }

        if (!resolvedUrl) {
          throw new Error("No URL found to stream.");
        }

        debugLog(`Fetching audio stream for: "${title}" from: "${resolvedUrl}"`);
        const stream = await playDlInstance.stream(resolvedUrl, { quality: 2, discordPlayerCompatibility: true });
        if (!stream || !stream.stream) {
          throw new Error("Stream extraction failed.");
        }

        const currentVolume = guildVolumes.get(guildId) !== undefined ? guildVolumes.get(guildId)! : 1.0;
        const resource = createAudioResource(stream.stream, {
          inputType: stream.type,
          inlineVolume: true
        });

        if (resource.volume) {
          resource.volume.setVolume(currentVolume);
        }

        guildActivePlayingResource.set(guildId, resource);
        
        const textChannel = guildActiveTextChannels.get(guildId);
        if (textChannel) {
          textChannel.send(`▶️ **Now playing:** **${title}**`).catch(() => {});
        }

        player.play(resource);
      } catch (innerErr: any) {
        debugLog(`Failed during execution of queue item in guild ${guildId}: ${innerErr.message}`);
        
        let errMsg = innerErr.message;
        let isBotBlock = false;
        if (errMsg.includes("Sign in to confirm you're not a bot") || errMsg.includes("Sign in to confirm")) {
            isBotBlock = true;
            errMsg = `YouTube is blocking playback on this network. \n\n🛠️ **To easily bypass this permanently:**\n1. Open the Web Dashboard of this app.\n2. Go to **Settings -> Advanced / Credentials**.\n3. Add a valid **YouTube Cookie**.\n\nSearching for an alternative on SoundCloud now...`;
        }
        
        const textChannel = guildActiveTextChannels.get(guildId);
        if (textChannel && isBotBlock) {
             textChannel.send(`⚠️ **Note:** ${errMsg}`).catch(() => {});
        } else if (textChannel && !isBotBlock) {
             textChannel.send(`❌ **Error playing ${title}:** ${errMsg}`).catch(() => {});
        }
        
        if (isBotBlock) {
            try {
                 debugLog(`Attempting SoundCloud fallback for: ${title}`);
                 const clientId = await playDlInstance.getFreeClientID();
                 await playDlInstance.setToken({ soundcloud: { client_id: clientId } });
                 const scQuery = nextItem.searchQuery || title;
                 const scResults = await playDlInstance.search(scQuery, { limit: 1, source: { soundcloud: 'tracks' } });
                 
                 if (scResults && scResults.length > 0) {
                     resolvedUrl = scResults[0].url;
                     title = `${scResults[0].name || scResults[0].title} (SoundCloud Alternative)`;
                     
                     const stream = await playDlInstance.stream(resolvedUrl, { discordPlayerCompatibility: true });
                     const currentVolume = guildVolumes.get(guildId) !== undefined ? guildVolumes.get(guildId)! : 1.0;
                     const resource = createAudioResource(stream.stream, {
                       inputType: stream.type,
                       inlineVolume: true
                     });
                     if (resource.volume) {
                       resource.volume.setVolume(currentVolume);
                     }
                     guildActivePlayingResource.set(guildId, resource);
                     if (textChannel) {
                       textChannel.send(`▶️ **Now playing alternative:** **${title}**`).catch(() => {});
                     }
                     player.play(resource);
                     return; // successfully recovered
                 } else {
                     if (textChannel) textChannel.send(`❌ **Fallback Failed:** No alternative found on SoundCloud.`).catch(() => {});
                 }
            } catch(fallbackErr: any) {
                 debugLog(`SoundCloud fallback failed: ${fallbackErr.message}`);
                 if (textChannel) textChannel.send(`❌ **Fallback Failed:** ${fallbackErr.message}`).catch(() => {});
            }
        }
        
        guildAudioPlayState.set(guildId, false);
        setTimeout(() => {
          playNextInGuildQueue(guildId, player);
        }, 1500);
      }
    })();

  } catch (error: any) {
    debugLog(`Synchronous play next error on guild ${guildId}: ${error.message}`);
    guildAudioPlayState.set(guildId, false);
    playNextInGuildQueue(guildId, player);
  }
}

export function enqueueMusicAudioForGuild(guildId: string, item: any, player: any) {
  resetDisconnectTimeout(guildId);
  let queue = guildAudioQueues.get(guildId);
  if (!queue) {
    queue = [];
    guildAudioQueues.set(guildId, queue);
  }
  queue.push(item);
  playNextInGuildQueue(guildId, player);
}

export async function ensureMusicVoiceConnectionReady(connection: any, channel: any): Promise<boolean> {
  const guildId = channel.guild.id;

  if (connection.state.status === VoiceConnectionStatus.Ready) {
    return true;
  }

  if (!connection._hasListeners) {
    connection._hasListeners = true;
    
    connection.on('error', (err: any) => {
      debugLog(`Error: ${err.message}`);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch (error) {
        connection.destroy();
      }
    });
  }

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20000);
    return true;
  } catch (error: any) {
    debugLog(`Ready stat timeout for channel "${channel.name}"`);
    const newConnection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });

    try {
      await entersState(newConnection, VoiceConnectionStatus.Ready, 10000);
      getOrCreateMusicGuildPlayer(guildId, newConnection);
      return true;
    } catch (retryErr: any) {
      debugLog(`Retry timeout for channel "${channel.name}"`);
      try {
        newConnection.destroy();
      } catch (e) {}
      return false;
    }
  }
}

export async function playMediaInMusicBot(query: string, channel: any, message: any) {
  const guildId = channel.guild.id;
  guildActiveTextChannels.set(guildId, message.channel);

  try {
    try {
      if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
         if (playDlInstance.is_expired()) {
           await playDlInstance.refreshToken();
         }
      }
    } catch(e) {}
    
    let itemsToQueue: any[] = [];
    let playlistTitle = "";
    
    if (query.includes('open.spotify.com')) {
      message.channel.send("🔍 Fetching Spotify details...").catch(() => {});
      try {
        const result = await scrapeSpotifyEmbed(query);
        playlistTitle = result.title;
        for (const track of result.tracks) {
          itemsToQueue.push({
            title: track.title,
            searchQuery: track.searchQuery,
            addedBy: message.author.username
          });
        }
      } catch (err: any) {
        debugLog(`Spotify scraping failed: ${err.message}. Retrying via play-dl fallback...`);
        try {
          const urlType = await playDlInstance.validate(query);
          if (urlType === 'sp_playlist' || urlType === 'sp_album') {
            const spData = await playDlInstance.spotify(query) as any;
            playlistTitle = spData.name || `Spotify Collection`;
            const tracks = await spData.all_tracks();
            for (const track of tracks) {
              itemsToQueue.push({
                title: track.name || "Spotify Track",
                searchQuery: `${track.name} ${track.artists ? track.artists.map((a: any) => a.name).join(' ') : ''}`,
                addedBy: message.author.username
              });
            }
          } else if (urlType === 'sp_track') {
            const spData = await playDlInstance.spotify(query) as any;
            itemsToQueue.push({
              title: spData.name || "Spotify Track",
              searchQuery: `${spData.name} ${spData.artists ? spData.artists.map((a: any) => a.name).join(' ') : ''}`,
              addedBy: message.author.username
            });
          } else {
            throw err;
          }
        } catch (playDlErr: any) {
          debugLog(`Play-dl Spotify fallback also failed: ${playDlErr.message}`);
          throw new Error(`Failed to play Spotify URL. Could not load embed or API metadata. (Ensure the link is public)`);
        }
      }
    } else {
      const urlType = await playDlInstance.validate(query);
      debugLog(`Validating query: "${query}". Result: "${urlType}"`);
      
      if (urlType === 'yt_playlist') {
        message.channel.send("🔍 Fetching YouTube playlist details...").catch(() => {});
        const playlist = await playDlInstance.playlist_info(query, { incomplete: true });
        const videos = await playlist.all_videos();
        playlistTitle = playlist.title || "YouTube Playlist";
        for (const video of videos) {
          if (video.url) {
            itemsToQueue.push({
              title: video.title || "YouTube Track",
              url: video.url,
              addedBy: message.author.username
            });
          }
        }
      } 
      else if (urlType === 'sp_playlist' || urlType === 'sp_album') {
        message.channel.send(`🔍 Fetching Spotify ${urlType === 'sp_playlist' ? 'playlist' : 'album'}...`).catch(() => {});
        const spData = await playDlInstance.spotify(query) as any;
        playlistTitle = spData.name || `Spotify ${urlType === 'sp_playlist' ? 'Playlist' : 'Album'}`;
        const tracks = await spData.all_tracks();
        for (const track of tracks) {
          itemsToQueue.push({
            title: track.name || "Spotify Track",
            searchQuery: `${track.name} ${track.artists ? track.artists.map((a: any) => a.name).join(' ') : ''}`,
            addedBy: message.author.username
          });
        }
      }
      else if (urlType === 'so_playlist') {
        message.channel.send("🔍 Fetching SoundCloud playlist tracks...").catch(() => {});
        const soData = await playDlInstance.soundcloud(query) as any;
        playlistTitle = soData.name || "SoundCloud Playlist";
        const tracks = await soData.all_tracks();
        for (const track of tracks) {
          if (track.url) {
            itemsToQueue.push({
              title: track.name || "SoundCloud Track",
              url: track.url,
              addedBy: message.author.username
            });
          }
        }
      }
      else if (urlType === 'sp_track') {
        const spData = await playDlInstance.spotify(query) as any;
        itemsToQueue.push({
          title: spData.name || "Spotify Track",
          searchQuery: `${spData.name} ${spData.artists ? spData.artists.map((a: any) => a.name).join(' ') : ''}`,
          addedBy: message.author.username
        });
      }
      else if (urlType === 'so_track') {
        const soData = await playDlInstance.soundcloud(query) as any;
        itemsToQueue.push({
          title: soData.name || "SoundCloud Track",
          url: soData.url,
          addedBy: message.author.username
        });
      }
      else if (!query.startsWith('http')) {
        const searchResults = await playDlInstance.search(query, { limit: 1 });
        if (!searchResults || searchResults.length === 0) {
          message.reply("Couldn't find any results for that query.");
          return;
        }
        itemsToQueue.push({
          title: searchResults[0].title || query,
          url: searchResults[0].url,
          addedBy: message.author.username
        });
      }
      else if (query.startsWith('http')) {
        let title = query;
        try {
          const info = await playDlInstance.video_basic_info(query);
          title = info.video_details.title || query;
        } catch (e) {}
        itemsToQueue.push({
          title: title,
          url: query,
          addedBy: message.author.username
        });
      }
      else {
        message.reply("Unsupported link or search query. Please try searching for a track name or providing a YouTube/Spotify/SoundCloud link.");
        return;
      }
    }

    if (itemsToQueue.length === 0) {
      message.reply("Failed to extract any playable tracks from the source.");
      return;
    }

    let connection = getVoiceConnection(guildId);
    if (!connection) {
      connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guildId,
        adapterCreator: channel.guild.voiceAdapterCreator,
      });
    } else if (connection.joinConfig.channelId !== channel.id) {
       connection = joinVoiceChannel({
         channelId: channel.id,
         guildId: guildId,
         adapterCreator: channel.guild.voiceAdapterCreator,
       });
    }

    const isReady = await ensureMusicVoiceConnectionReady(connection, channel);
    if (!isReady) {
      message.reply("Failed to connect to the voice channel properly.");
      return;
    }

    const player = getOrCreateMusicGuildPlayer(guildId, connection);
    
    resetDisconnectTimeout(guildId);
    activeGuildIds.add(guildId);

    let queue = guildAudioQueues.get(guildId);
    if (!queue) {
      queue = [];
      guildAudioQueues.set(guildId, queue);
    }

    const isPlaying = guildAudioPlayState.get(guildId);
    
    for (const item of itemsToQueue) {
      queue.push(item);
    }

    if (itemsToQueue.length > 1) {
      message.channel.send(`🎵 **Queued ${itemsToQueue.length} songs** from **"${playlistTitle}"** (added by ${message.author.toString()})`).catch(() => {});
    } else if (isPlaying) {
      message.channel.send(`🎵 **Queued:** **${itemsToQueue[0].title}** (added by ${message.author.toString()})`).catch(() => {});
    }

    if (!isPlaying) {
      playNextInGuildQueue(guildId, player);
    }
  } catch (err: any) {
    debugLog(`Error in playMediaInMusicBot: ${err.message}`);
    let errMsg = err.message;
    if (errMsg.includes("Sign in to confirm you're not a bot") || errMsg.includes("Sign in to confirm")) {
        errMsg = `YouTube is blocking playback on this network.\n\n🛠️ **To easily bypass this permanently:**\n1. Open the Web Dashboard of this app.\n2. Go to **Settings -> Advanced / Credentials**.\n3. Add a valid **YouTube Cookie**.`;
    }
    message.reply(`An error occurred while trying to queue: ${errMsg}`).catch(() => {});
  }
}

export function isDiscordMusicConnected() {
  return !!(client && client.isReady());
}

export function setMusicVolume(guildId: string, volume: number) {
  guildVolumes.set(guildId, volume);
  try {
    const resource = guildActivePlayingResource.get(guildId);
    if (resource && resource.volume) {
      resource.volume.setVolume(volume);
    }
  } catch (e) {}
}

let globalVolumeState = 1.0;

export function getGlobalMusicVolume() {
  return globalVolumeState;
}

export function setGlobalMusicVolume(volume: number) {
  globalVolumeState = volume;
  if (client) {
    for (const guildId of client.guilds.cache.keys()) {
      setMusicVolume(guildId, volume);
    }
  }
}

export async function initDiscordMusicBot(token?: string, isStartup = false): Promise<void> {
  const currentToken = (token || process.env.DISCORD_MUSIC_TOKEN || '').trim();
  if (!currentToken || currentToken.length < 50 || currentToken.includes("INSERT_YOUR_DISCORD_BOT_TOKEN_HERE")) {
    if (isStartup) {
      debugLog("Discord Music Bot token not set or is a placeholder. Skipping startup initialization.");
      return;
    }
    throw new Error("Invalid token format.");
  }

  if (client) {
    client.destroy();
  }

  const tryLoginWithIntents = (intentsList: any[]): Promise<void> => {
    return new Promise((resolve, reject) => {
      client = new Client({ intents: intentsList });

      client.on('ready', () => {
        debugLog(`Discord Music Bot logged in and READY as: ${client?.user?.tag}`);
        resolve();
      });

      client.on('messageCreate', async (message) => {
        try {
          if (!message.guild || message.author.bot) return;

          const content = message.content.trim();
          const lower = content.toLowerCase();
          
          if (lower.startsWith('!play ') || lower.startsWith('/play ') || lower.startsWith('.play ') || lower.startsWith('play ') || lower.startsWith('p ') || lower.startsWith('!p ') || lower.startsWith('/p ') || lower.startsWith('.p ')) {
            const firstSpaceIdx = lower.indexOf(' ');
            if (firstSpaceIdx === -1) return;
            const query = content.substring(firstSpaceIdx + 1).trim();
            if (!query) return;

            const member = message.guild.members.cache.get(message.author.id) || await message.guild.members.fetch(message.author.id).catch(() => null);
            const voiceChannel = member?.voice?.channel;
            if (voiceChannel) {
              message.react('🎵').catch(() => {});
              playMediaInMusicBot(query, voiceChannel, message);
            } else {
              message.react('❌').catch(() => {});
              message.reply('You need to be in a voice channel to play music.');
            }
          }
          else if (['!skip', '.skip', '/skip', 'skip', 's', '!s', '/s', '.s'].includes(lower)) {
             const guildId = message.guild.id;
             let player = guildPlayers.get(guildId);
             if (player) {
                player.stop();
                message.react('⏭️').catch(() => {});
                message.channel.send(`⏭️ **Skipped by ${message.author.toString()}**`).catch(() => {});
             }
          }
           else if (['!queue', '.queue', '/queue', 'queue', 'q', '!q', '/q', '.q'].includes(lower)) {
             const queue = guildAudioQueues.get(message.guild.id) || [];
             if (queue.length === 0) {
               message.reply("The queue is currently empty.");
             } else {
               message.reply(`**Current Queue:**\n${queue.slice(0, 15).map((q, i) => `${i + 1}. **${q.title}** (added by ${q.addedBy})`).join('\n')}${queue.length > 15 ? `\n*...and ${queue.length - 15} more tracks.*` : ''}`);
             }
          }
          else if (lower.startsWith('!volume ') || lower.startsWith('/volume ') || lower.startsWith('.volume ') || lower.startsWith('volume ') || lower.startsWith('v ') || lower.startsWith('!v ')) {
             const args = content.split(' ');
             const volRaw = args[1];
             if (!volRaw) {
               const cur = (guildVolumes.get(message.guild.id) !== undefined ? guildVolumes.get(message.guild.id)! : 1.0) * 100;
               message.reply(`Volume is currently ${Math.round(cur)}%`);
             } else {
               const parsedVol = parseInt(volRaw, 10);
               if (isNaN(parsedVol) || parsedVol < 1 || parsedVol > 200) {
                 message.reply("Please provide a valid volume between 1 and 200.");
               } else {
                 setMusicVolume(message.guild.id, parsedVol / 100);
                 message.react('🔊').catch(() => {});
                 message.channel.send(`🔊 Volume set to **${parsedVol}%** by ${message.author.username}`);
               }
             }
          }
          else if (['!help', '.help', '/help', 'help', 'h', '!h', '/h', '.h', '!tulong', '/tulong', '.tulong', 'tulong'].includes(lower)) {
               message.reply(customHelpText);
          }
        } catch (err: any) {
          debugLog(`Error processing music message listener: ${err.message}`);
        }
      });

      client.on('error', (err) => {
        debugLog(`Client error: ${err.message}`);
      });

      client.login(currentToken).catch((err: any) => {
        if (isStartup && err.message?.includes('An invalid token was provided')) {
          debugLog("Startup login check: The provided Discord Music token is invalid or inactive.");
          if (client) {
            try { client.destroy(); } catch (e) {}
          }
          client = null;
          resolve();
        } else {
          reject(err);
        }
      });
    });
  };

  try {
    await tryLoginWithIntents([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent 
    ]);
  } catch (err: any) {
    if (isStartup) {
      debugLog(`Initial login bypassed: ${err.message}`);
    } else {
      debugLog(`Initial login failed: ${err.message}`);
      throw err;
    }
  }
}

export function stopDiscordMusicBot() {
  debugLog("Stopping music bot...");
  for (const guildId of activeGuildIds) {
    resetDisconnectTimeout(guildId);
    try {
      const connection = getVoiceConnection(guildId);
      if (connection) {
        connection.destroy();
      }
    } catch (e: any) {}
  }
  activeGuildIds.clear();

  if (client) {
    try {
      client.destroy();
    } catch (e: any) {}
    client = null;
  }
}
