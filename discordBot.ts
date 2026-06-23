import { Client, GatewayIntentBits, VoiceChannel, ChannelType } from 'discord.js';
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
import * as googleTTS from 'google-tts-api';
import { EdgeTTS } from 'node-edge-tts';
import os from 'os';
import crypto from 'crypto';
import ffmpeg from 'ffmpeg-static';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import dns from 'dns';
import { Readable } from 'stream';

if (dns && typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

process.on('unhandledRejection', (reason: any, promise) => {
  const reasonStr = reason ? (reason.message || String(reason)) : '';
  if (reasonStr.includes('Cannot perform IP discovery') || reasonStr.includes('socket closed')) {
    debugLog(`[Voice Connection Diagnostics] Cleanly handled anticipated network issue: UDP IP discovery is limited/sandboxed in this container. This is expected in the Google AI Studio Sandbox/Cloud Run environment, but voice will work seamlessly on VPS/production deployments.`);
    return;
  }
  debugLog(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

process.on('uncaughtException', (err: any) => {
  const errStr = err ? (err.message || String(err)) : '';
  if (errStr.includes('Cannot perform IP discovery') || errStr.includes('socket closed')) {
    debugLog(`[Voice Connection Diagnostics] Cleanly handled anticipated network uncaught exception: UDP IP discovery socket closed (expected in Google Cloud Run / Sandbox environment).`);
    return;
  }
  debugLog(`Uncaught Exception: ${err}`);
});

export function debugLog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(path.join(process.cwd(), 'discord-debug.log'), line);
  } catch (e) {}
  console.log(`[DISCORD-DEBUG] ${msg}`);
}

if (ffmpeg) {
  process.env.FFMPEG_PATH = ffmpeg;
  const ffmpegDir = path.dirname(ffmpeg);
  if (!process.env.PATH?.includes(ffmpegDir)) {
    process.env.PATH = `${ffmpegDir}:${process.env.PATH}`;
  }
  debugLog(`FFMPEG configured successfully at: ${ffmpeg}`);
} else {
  debugLog("FFMPEG-STATIC was not found!");
}

let client: Client | null = null;
const activeGuildIds = new Set<string>();

async function resolveMentions(text: string, guild: any): Promise<string> {
  if (!text) return text;
  let resolved = text;

  // Resolve user mentions: <@123456789> or <@!123456789>
  const userRegex = /<@!?(\d+)>/g;
  const userMatches = [...resolved.matchAll(userRegex)];
  for (const match of userMatches) {
    const fullMatch = match[0];
    const userId = match[1];
    let name = "someone";
    if (guild) {
      try {
        let member = guild.members.cache.get(userId);
        if (!member) {
          member = await guild.members.fetch(userId).catch(() => null);
        }
        if (member) {
          name = member.displayName || member.user.username;
        }
      } catch (e) {}
    }
    if (name === "someone") {
      try {
        let user = client?.users.cache.get(userId);
        if (!user) {
          user = await client?.users.fetch(userId).catch(() => null);
        }
        if (user) {
          name = user.displayName || user.username;
        }
      } catch (e) {}
    }
    resolved = resolved.replace(fullMatch, name);
  }

  // Resolve role mentions: <@&123456789>
  const roleRegex = /<@&(\d+)>/g;
  const roleMatches = [...resolved.matchAll(roleRegex)];
  for (const match of roleMatches) {
    const fullMatch = match[0];
    const roleId = match[1];
    let name = "a role";
    if (guild) {
      try {
        let role = guild.roles.cache.get(roleId);
        if (!role) {
          role = await guild.roles.fetch(roleId).catch(() => null);
        }
        if (role) {
          name = role.name;
        }
      } catch (e) {}
    }
    resolved = resolved.replace(fullMatch, name);
  }

  // Resolve channel mentions: <#123456789>
  const channelRegex = /<#(\d+)>/g;
  const channelMatches = [...resolved.matchAll(channelRegex)];
  for (const match of channelMatches) {
    const fullMatch = match[0];
    const channelId = match[1];
    let name = "a channel";
    if (guild) {
      try {
        let channel = guild.channels.cache.get(channelId);
        if (!channel) {
          channel = await guild.channels.fetch(channelId).catch(() => null);
        }
        if (channel) {
          name = channel.name;
        }
      } catch (e) {}
    }
    if (name === "a channel") {
      try {
        const globalChannel = client?.channels.cache.get(channelId) || await client?.channels.fetch(channelId).catch(() => null);
        if (globalChannel && 'name' in globalChannel) {
          name = (globalChannel as any).name;
        }
      } catch (e) {}
    }
    resolved = resolved.replace(fullMatch, name);
  }

  return resolved;
}

export function getOrCreateVoiceConnection(channel: any): any {
  const guildId = channel.guild.id;
  activeGuildIds.add(guildId);
  let connection = getVoiceConnection(guildId);
  
  // If there's an existing voice connection but it's in a broken state, destroy it first so we can rebuild cleanly
  if (connection) {
    const status = connection.state.status;
    if (status === VoiceConnectionStatus.Disconnected || status === VoiceConnectionStatus.Destroyed) {
      debugLog(`Existing connection in guild ${guildId} is ${status}. Destroying to reconnect cleanly.`);
      try {
        connection.destroy();
      } catch (e) {}
      connection = null;
    } else if (connection.joinConfig.channelId !== channel.id) {
      debugLog(`Channel mismatch for guild ${guildId} (expected "${channel.name}" but connected to channel ID ${connection.joinConfig.channelId}). Destroying and switching.`);
      try {
        connection.destroy();
      } catch (e) {}
      connection = null;
    }
  }

  if (!connection) {
    debugLog(`Connecting to voice channel: "${channel.name}" in guild "${channel.guild.name}"...`);
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guildId,
      adapterCreator: channel.guild.voiceAdapterCreator as any,
      selfDeaf: true,
      selfMute: false,
    });
  }

  return connection;
}

export async function ensureVoiceConnectionReady(connection: any, channel: any): Promise<boolean> {
  const guildId = channel.guild.id;

  // If already ready, return instantly
  if (connection.state.status === VoiceConnectionStatus.Ready) {
    return true;
  }

  // Hook listeners for robust reconnection state changes
  if (!connection._hasListeners) {
    connection._hasListeners = true;
    
    connection.on('error', (err: any) => {
      debugLog(`[Voice Connection Error Handled] Guild ${guildId} encountered connection or IP discovery issue: ${err.message}`);
    });

    connection.on('stateChange', (oldState: any, newState: any) => {
      debugLog(`[Voice Connection State Change] Guild ${guildId}: ${oldState.status} -> ${newState.status}`);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // If disconnected, try to wait for automatic reconnection signalling/connecting
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 4000),
          entersState(connection, VoiceConnectionStatus.Connecting, 4000),
        ]);
      } catch (error) {
        debugLog(`[Voice Connection] Real disconnection detected for guild ${guildId}. Attempting automatic reconnection...`);
        try {
          connection.reconnect();
        } catch (e: any) {
          debugLog(`[Voice Connection] Reconnect attempt failed: ${e.message}`);
        }
      }
    });
  }

  try {
    debugLog(`Waiting for Voice Connection to become READY in channel "${channel.name}"...`);
    // Standard 10s wait for GCP Cloud Run / Sandbox networks
    await entersState(connection, VoiceConnectionStatus.Ready, 10000);
    debugLog(`Voice Connection is now READY in channel "${channel.name}"`);
    return true;
  } catch (err: any) {
    debugLog(`[Voice Connection Stalled] Connection failed to reach READY status. Current state: "${connection.state.status}". Error: ${err.message}`);
    debugLog(`[Diagnosis] A voice connection stuck in "signalling" state typically indicates:`);
    debugLog(`  * Option A: Dynamic outward UDP egress/sockets are sandboxed or restricted in this container. This is expected in the Google AI Studio Sandbox/Cloud Run environment, but will work seamlessly on your dedicated CloudPanel VPS deployment where dynamic UDP routing is fully enabled.`);
    debugLog(`  * Option B: Bot Token conflict. If your production bot at https://secretary.mafia.anvorte.com/ is simultaneously running with this exact token, Discord kills the voice session state for one client. You can use the "Disconnect Bot" button on the UI dashboard to turn off the bot here!`);
    
    // --- Self-Healing Retry ---
    // Re-creating the connection forces a brand-new UDP socket binding which handles strict NATs / frozen routes
    debugLog(`[Self-Healing] Re-creating a brand-new connection for channel "${channel.name}" to force fresh socket routing...`);
    try {
      connection.destroy();
    } catch (e) {}

    const newConnection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guildId,
      adapterCreator: channel.guild.voiceAdapterCreator as any,
      selfDeaf: true,
      selfMute: false,
    });

    newConnection.on('error', (err: any) => {
      debugLog(`[Voice Connection Retry Error Handled] Guild ${guildId} encountered connection or IP discovery issue: ${err.message}`);
    });

    newConnection.on('stateChange', (oldState: any, newState: any) => {
      debugLog(`[Voice Connection Retry State Change] Guild ${guildId}: ${oldState.status} -> ${newState.status}`);
    });

    try {
      await entersState(newConnection, VoiceConnectionStatus.Ready, 10000);
      debugLog(`[Self-Healing SUCCESS] Retried connection succeeded! Voice is now READY.`);
      // Update persistent player registry with the new connection if necessary
      getOrCreateGuildPlayer(guildId, newConnection);
      return true;
    } catch (retryErr: any) {
      debugLog(`[Self-Healing FAILURE] Ready state retry also timed out for channel "${channel.name}": ${retryErr.message}`);
      try {
        newConnection.destroy();
      } catch (e) {}
      return false;
    }
  }
}

const globalVoicePlayer = createAudioPlayer();

globalVoicePlayer.on('error', error => {
  console.error('Audio Player Error:', error.message);
});

const lastSpokenValues = new Map<string, number>();

// Persistent Player registry
const guildPlayers = new Map<string, any>();

interface GuildQueueItem {
  type: 'local' | 'buffer';
  data: string | Buffer; // file path or audio buffer
}

const guildAudioQueues = new Map<string, GuildQueueItem[]>();
const guildAudioPlayState = new Map<string, boolean>();

const guildDisconnectTimeouts = new Map<string, NodeJS.Timeout>();

export function resetDisconnectTimeout(guildId: string) {
  if (guildDisconnectTimeouts.has(guildId)) {
    clearTimeout(guildDisconnectTimeouts.get(guildId)!);
    guildDisconnectTimeouts.delete(guildId);
  }
}

export function startDisconnectTimeout(guildId: string) {
  resetDisconnectTimeout(guildId);
  debugLog(`Starting 5-minute TTS bot inactivity disconnect timer for guild ${guildId}`);
  const timeout = setTimeout(() => {
    debugLog(`Inactivity timeout reached: Disconnecting TTS bot from guild ${guildId}`);
    try {
      const connection = getVoiceConnection(guildId);
      if (connection) {
        connection.destroy();
      }
    } catch (e: any) {
      debugLog(`Error disconnecting TTS bot on inactivity: ${e.message}`);
    }
    guildPlayers.delete(guildId);
    guildAudioQueues.delete(guildId);
    guildAudioPlayState.delete(guildId);
    activeGuildIds.delete(guildId);
    guildDisconnectTimeouts.delete(guildId);
  }, 5 * 60 * 1000); // 5 minutes
  guildDisconnectTimeouts.set(guildId, timeout);
}

export function getOrCreateGuildPlayer(guildId: string, connection: any) {
  let player = guildPlayers.get(guildId);
  if (!player) {
    player = createAudioPlayer();
    guildPlayers.set(guildId, player);
    
    player.on('error', (error: any) => {
      debugLog(`Persistent Player error on guild ${guildId}: ${error.message}`);
    });

    player.on(AudioPlayerStatus.Idle, () => {
      // Finished playing current item
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
  if (guildAudioPlayState.get(guildId)) return; // Already playing

  const queue = guildAudioQueues.get(guildId);
  if (!queue || queue.length === 0) return;

  const nextItem = queue.shift();
  if (!nextItem) return;

  guildAudioPlayState.set(guildId, true);
  try {
    let resource;
    if (nextItem.type === 'local') {
      resource = createAudioResource(nextItem.data as string, {
        inputType: StreamType.Arbitrary
      });
    } else {
      const stream = Readable.from(nextItem.data as Buffer);
      resource = createAudioResource(stream, {
        inputType: StreamType.Arbitrary
      });
    }
    player.play(resource);
    debugLog(`Play triggered on persistent player in guild: ${guildId}`);
  } catch (error: any) {
    debugLog(`Failed during execution of queue item in guild ${guildId}: ${error.message}`);
    guildAudioPlayState.set(guildId, false);
    playNextInGuildQueue(guildId, player); // Skip to next
  }
}

export function enqueueAudioForGuild(guildId: string, item: GuildQueueItem, player: any) {
  resetDisconnectTimeout(guildId);
  let queue = guildAudioQueues.get(guildId);
  if (!queue) {
    queue = [];
    guildAudioQueues.set(guildId, queue);
  }
  queue.push(item);
  playNextInGuildQueue(guildId, player);
}


const GODFATHER_CACHE_PATH = path.join(process.cwd(), 'godfather-theme-15s.mp3');

export async function ensureGodfatherThemeCached(): Promise<string> {
  if (fs.existsSync(GODFATHER_CACHE_PATH)) {
    const stats = fs.statSync(GODFATHER_CACHE_PATH);
    if (stats.size > 1000) {
      return GODFATHER_CACHE_PATH;
    }
  }

  debugLog(`Godfather theme not found at: ${GODFATHER_CACHE_PATH}`);
  throw new Error('Godfather theme 15s audio is missing from the directory.');
}

const cacheList = [
  { key: '10', text: '10' },
  { key: '9', text: '9' },
  { key: '8', text: '8' },
  { key: '7', text: '7' },
  { key: '6', text: '6' },
  { key: '5', text: '5' },
  { key: '4', text: '4' },
  { key: '3', text: '3' },
  { key: '2', text: '2' },
  { key: '1', text: '1' },
  { key: 'clear-comms', text: 'Clear comms and chat and get that win.' }
];

const cachedSpeechPaths = new Map<string, string>();

export async function preCacheSpeechSounds(): Promise<void> {
  debugLog("Pre-caching standard alert sounds...");
  for (const item of cacheList) {
    const targetPath = path.join(process.cwd(), `sound-cache-${item.key}.mp3`);
    cachedSpeechPaths.set(item.key, targetPath);
    
    if (fs.existsSync(targetPath)) {
      const stats = fs.statSync(targetPath);
      if (stats.size > 100) {
        continue;
      }
    }
    
    try {
      const url = getAudioUrl(item.text);
      const res = await fetch(url);
      if (res.ok) {
        const arrayBuf = await res.arrayBuffer();
        fs.writeFileSync(targetPath, Buffer.from(arrayBuf));
        debugLog(`Pre-cached speech voice: "${item.text}" to ${targetPath}`);
      } else {
        debugLog(`Failed to pre-cache "${item.text}" with code ${res.status}`);
      }
    } catch (e: any) {
      debugLog(`Error pre-caching speech "${item.text}": ${e.message}`);
    }
  }

  try {
    await ensureGodfatherThemeCached();
  } catch (e: any) {
    debugLog(`Godfather caching warning: ${e.message}`);
  }
}

export async function playLocalFileInChannels(filePath: string, channelIds: string[]) {
  if (!client || !channelIds || channelIds.length === 0) {
    const fallbackId = process.env.DISCORD_VOICE_CHANNEL_ID;
    if (fallbackId) channelIds = [fallbackId];
    else return;
  }

  debugLog(`Requested local file playback: "${filePath}" into channels: ${channelIds.join(', ')}`);

  for (const channelId of channelIds) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        continue;
      }

      const connection = getOrCreateVoiceConnection(channel);
      const isReady = await ensureVoiceConnectionReady(connection, channel);
      if (!isReady) {
        continue;
      }

      const player = getOrCreateGuildPlayer(channel.guild.id, connection);
      enqueueAudioForGuild(channel.guild.id, {
        type: 'local',
        data: filePath
      }, player);
    } catch (error: any) {
      debugLog(`Failed during execution of playLocalFile in channel ${channelId}: ${error.message}`);
    }
  }
}

export function isDiscordConnected() {
  return !!(client && client.isReady());
}

export interface DiscordBotSettings {
  voiceLang?: string;
}

export async function initDiscordBot(
  globalSettings: DiscordBotSettings,
  token?: string
): Promise<void> {
  const currentToken = (token || process.env.DISCORD_TOKEN || '').trim();
  // Prevent login attempt with obvious invalid or placeholder tokens
  if (!currentToken || currentToken === 'undefined' || currentToken.length < 50 || currentToken.includes("INSERT_YOUR_DISCORD_BOT_TOKEN_HERE")) {
    throw new Error("Invalid token format.");
  }

  if (client) {
    client.destroy();
  }

  const tryLoginWithIntents = (intentsList: any[]): Promise<void> => {
    return new Promise((resolve, reject) => {
      client = new Client({
        intents: intentsList
      });

      client.on('ready', () => {
        debugLog(`Discord bot logged in and READY as: ${client?.user?.tag}`);
        preCacheSpeechSounds().catch(err => {
          debugLog(`Pre-caching error (non-fatal): ${err.message}`);
        });

        // Register /ss global slash commands and clear redundant guild commands to prevent duplicates
        try {
          client?.application?.commands.create({
            name: 'ss',
            description: 'Speak a message aloud into your voice channel chat/channel',
            options: [
              {
                name: 'text',
                type: 3, // String type
                description: 'The text for Mafia Secretary to speak',
                required: true
              }
            ]
          }).then(() => {
            debugLog(`Successfully registered global slash command '/ss'`);
          }).catch(err => {
            debugLog(`Failed during global slash command '/ss' registration: ${err.message}`);
          });

          // Clear guild-level /ss commands so they don't double-up with the global command
          client?.guilds.cache.forEach(guild => {
            guild.commands.set([]).then(() => {
              debugLog(`Cleared custom guild-level slash commands for: "${guild.name}" to prevent duplication.`);
            }).catch(err => {
              debugLog(`Guild-level command resetting bypassed or failed for "${guild.name}": ${err.message}`);
            });
          });

        } catch (err: any) {
          debugLog(`Error cleaning up & registering slash commands: ${err.message}`);
        }

        resolve();
      });

      client.on('interactionCreate', async (interaction) => {
        try {
          if (!interaction.isChatInputCommand()) return;
          if (interaction.commandName === 'ss') {
            // SECURE IMMEDIATE DEFERRAL to completely prevent 3-second Discord expiration ("Unknown interaction")
            await interaction.deferReply().catch(err => {
              debugLog(`Immediate deferReply failed: ${err.message}`);
            });

            const textToSpeak = interaction.options.getString('text');
            if (!textToSpeak) {
              await interaction.editReply({ content: "❌ Please supply the text to speak." }).catch(() => {});
              return;
            }

            const member = interaction.guild?.members.cache.get(interaction.user.id);
            const voiceChannel = member?.voice?.channel;
            if (voiceChannel) {
              try {
                debugLog(`Interactions command (/ss) triggered by ${interaction.user.tag} for: "${textToSpeak}"`);
                const cleanSpeech = await resolveMentions(textToSpeak, interaction.guild);
                await playAudioInVoiceChannels(cleanSpeech, [voiceChannel.id], globalSettings.voiceLang || 'en');
                await interaction.editReply({ content: `🗣️ *Speaking:* "${textToSpeak}"` }).catch(() => {});
              } catch (playErr: any) {
                debugLog(`Failed to speak via interactions: ${playErr.message}`);
                await interaction.editReply({ content: `❌ Stalled voice stream: ${playErr.message}` }).catch(() => {});
              }
            } else {
              await interaction.editReply({ content: `❌ You must join a voice channel for Mafia Secretary to speak.` }).catch(() => {});
            }
          }
        } catch (err: any) {
          debugLog(`Error processing slash interaction: ${err.message}`);
        }
      });

      // Only mount the messageCreate handler if we have the messages permission
      if (intentsList.includes(GatewayIntentBits.GuildMessages)) {
        client.on('messageCreate', async (message) => {
          try {
            if (!message.guild || message.author.bot) return;

            const content = message.content.trim();
            let textToSpeak = '';
            
            // Match clean /ss as a fast alternate, !ss, .ss, or ss prefix-less commands
            const lower = content.toLowerCase();
            if (lower.startsWith('ss ')) {
              textToSpeak = content.substring(3).trim();
            } else if (lower.startsWith('!ss ')) {
              textToSpeak = content.substring(4).trim();
            } else if (lower.startsWith('.ss ')) {
              textToSpeak = content.substring(4).trim();
            } else if (lower.startsWith('/ss ')) {
              textToSpeak = content.substring(4).trim();
            }

            if (!textToSpeak) return;

            // Get guild member
            const member = message.guild.members.cache.get(message.author.id) || await message.guild.members.fetch(message.author.id).catch(() => null);
            const voiceChannel = member?.voice?.channel;
            if (voiceChannel) {
              const chName = 'name' in message.channel ? (message.channel as any).name : 'unknown-channel';
              debugLog(`Plain-text text transmission triggered by ${message.author.tag} in channel ${chName}: "${textToSpeak}"`);
              
              // Instantly react to the Discord message for beautiful, fast non-blocking feedback!
              message.react('🗣️').catch(() => {});
              
              const cleanSpeech = await resolveMentions(textToSpeak, message.guild);
              await playAudioInVoiceChannels(cleanSpeech, [voiceChannel.id], globalSettings.voiceLang || 'en');
            } else {
              message.react('❌').catch(() => {});
            }
          } catch (err: any) {
            debugLog(`Error processing text message listener: ${err.message}`);
          }
        });
      }

      client.on('error', (err) => {
        debugLog(`Discord client error event: ${err.message}`);
      });

      client.login(currentToken).catch(err => {
        reject(err);
      });
    });
  };

  try {
    debugLog("Attempting connection with direct text-reading intent (Privileged MessageContent)");
    await tryLoginWithIntents([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]);
  } catch (err: any) {
    const errMsg = (err.message || '').toLowerCase();
    if (errMsg.includes('disallowed') || errMsg.includes('privileged') || err.code === 'DisallowedIntents') {
      debugLog("⚠️ NOTICE: The bot prompt listener is currently using a graceful fallback state!");
      debugLog("⚠️ Problem detected: 'Message Content Intent' is not enabled in your Discord Developer Bot Portal.");
      debugLog("⚠️ Outcome: Regular chat message triggers (like typing 'ss hello' or '!ss hello') are bypassed. Slash command '/ss hello' remains fully functional.");
      debugLog("⚠️ To fix: Go to https://discord.com/developers/applications, select your bot, click the 'Bot' tab, scroll down to 'Privileged Gateway Intents', turn on 'Message Content Intent', and click 'Save Changes'.");
      debugLog("🔄 Booting bot on fallback intents mode right now...");
      
      if (client) {
        try { client.destroy(); } catch (e) {}
      }

      await tryLoginWithIntents([
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
      ]);
    } else {
      if (client) {
        try { client.destroy(); } catch (e) {}
      }
      client = null;
      throw err;
    }
  }
}

// Ensure clean audio URL fetching via google-tts-api
function getAudioUrl(text: string) {
  return googleTTS.getAudioUrl(text, {
    lang: 'en-US',
    slow: false,
    host: 'https://translate.google.com',
  });
}

export function getAvailableVoiceChannels() {
  if (!client) return [];
  const channels: { id: string; name: string; guildName: string }[] = [];
  client.guilds.cache.forEach(guild => {
    guild.channels.cache.forEach(channel => {
      if (channel.type === ChannelType.GuildVoice) {
        channels.push({
          id: channel.id,
          name: channel.name,
          guildName: guild.name,
        });
      }
    });
  });
  return channels;
}

export function isTaglishOrTagalog(text: string): boolean {
  const normalized = text.toLowerCase();
  const tagalogWords = new Set([
    'po', 'opo', 'na', 'pa', 'ba', 'sa', 'ng', 'mga', 'ang', 'at', 'o',
    'ako', 'ikaw', 'ka', 'kami', 'tayo', 'sila', 'natin', 'namin', 'inyo', 'kanya', 'kanila', 'ito', 'iyan', 'iyon', 'dito', 'diyan', 'doon', 'kayo',
    'gising', 'tulog', 'tara', 'laro', 'lods', 'boss', 'pre', 'gago', 'tangina', 'tanginang', 'putangina', 'putanginang', 'kupal', 'bobo', 'pucha', 
    'boto', 'botohan', 'vouch', 'patay', 'buhay', 'pumatay', 'papatay', 'mafia', 'secretary', 
    'bata', 'kuya', 'ate', 'kapit', 'ano', 'bakit', 'paano', 'kailan', 'saan', 'sino', 'salamat', 
    'kamusta', 'kumusta', 'wala', 'meron', 'mayroon', 'hindi', 'oo', 'lang', 'naman', 'nga', 'din', 'rin',
    'gabi', 'umaga', 'tanghali', 'hapon', 'araw', 'oras', 'sulat', 'basa', 'magulo', 'ayos', 'basta', 
    'talaga', 'sige', 'muna', 'pala', 'sana', 'kahit', 'mismo', 'kasi', 'dahil', 'kaya', 'para',
    'ung', 'yung', 'nung', 'noong', 'bkt', 'bat', 'sn', 'san', 'pn', 'pano', 'kelan', 'kln', 'gnn', 
    'ganun', 'ganoon', 'ngyon', 'ngyn', 'ngayon', 'nyo', 'ninyo', 'nya', 'niya', 'sya', 'siya', 
    'mya', 'mamaya', 'di', 'wg', 'wag', 'hwag', 'huwag', 'pd', 'pde', 'pwede', 'puwede', 
    'aq', 'kau', 'tyo', 'd2', 'dun', 'dyn', 'kc', 'kse', 'cnu', 'sno', 'gnun', 'gnyan', 
    'tlga', 'khit', 'cg', 'cge', 'pro', 'lng', 'nka', 'nman', 'nmn',
    'ko', 'mo', 'nila', 'niyo', 'kila', 'kay', 'ni', 'ay', 'eh', 'ah', 'oh', 'daw', 'raw', 
    'din', 'rin', 'ba', 'nga', 'pala', 'kaya', 'sana', 'yata', 'tuloy', 'naman', 'namn', 'nman', 
    'yan', 'nito', 'nyan', 'noon', 'ngayon', 'natin', 'atin', 'amin', 'inyo', 'kanila', 
    'isa', 'dalawa', 'tatlo', 'apat', 'lima', 'anim', 'pito', 'walo', 'siyam', 'sampu',
    'gusto', 'ayaw', 'kailangan', 'pwede', 'maaari', 'dapat', 'baka', 'siguro', 'marahil',
    'oo', 'hindi', 'wala', 'meron', 'mayroon', 'oo', 'opo', 'hindi', 'po', 'opo', 'ha',
    'sige', 'tama', 'mali', 'totoo', 'sinungaling', 'talaga', 'sobra', 'grabe', 'lalo', 'mas',
    'sobrang', 'grabeng', 'masyado', 'masyadong', 'baka', 'bka'
  ]);

  const words = normalized.split(/[^a-zA-Z]+/).filter(w => w.length > 0);
  if (words.length === 0) return false;

  let tagalogMatchCount = 0;
  for (const word of words) {
    if (tagalogWords.has(word)) {
      tagalogMatchCount++;
    }
  }

  // To prevent English sentences from triggering Tagalog voice due to short words like "na" / "ba":
  // We trigger tagalog TTS if at least 25% of the sentence is tagalog words, or if there are 3+ tagalog words.
  const ratio = tagalogMatchCount / words.length;
  if (ratio >= 0.20 || tagalogMatchCount >= 2) {
    return true;
  }

  // Strong explicit standalone indicators
  if (/(?:\s|^)mga(?:\s|$)/.test(normalized) || /(?:\s|^)ng(?:\s|$)/.test(normalized) || /(?:\s|^)ang(?:\s|$)/.test(normalized)) {
    return true;
  }

  return false;
}

function numberToEnglishWords(num: number): string {
  if (num === 0) return 'zero';
  const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  
  function helper(n: number): string {
    if (n < 20) return ones[n];
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 !== 0 ? ' ' + ones[n % 10] : '');
    if (n < 1000) return ones[Math.floor(n / 100)] + ' hundred' + (n % 100 !== 0 ? ' ' + helper(n % 100) : '');
    if (n < 1000000) return helper(Math.floor(n / 1000)) + ' thousand' + (n % 1000 !== 0 ? ' ' + helper(n % 1000) : '');
    if (n < 1000000000) return helper(Math.floor(n / 1000000)) + ' million' + (n % 1000000 !== 0 ? ' ' + helper(n % 1000000) : '');
    return n.toString();
  }
  return helper(num);
}

export function replaceNumbersWithEnglishWords(text: string): string {
  return text.replace(/\b\d+\b/g, (match) => {
    const num = parseInt(match, 10);
    if (!isNaN(num) && num < 1000000000) {
      return numberToEnglishWords(num);
    }
    return match;
  });
}

export function normalizeTextForTTS(text: string): string {
  let normalized = text;
  
  // 1. Strip Discord custom emojis (e.g. <:emoji_name:1234567890> or <a:emoji_name:1234567890>)
  // Replace with just their name to avoid spelling details but preserve context.
  normalized = normalized.replace(/<a?:([a-zA-Z0-9_]+):\d+>/g, ' $1 ');

  // 2. Remove standard HTML tags (e.g., <span>, <img>, etc.) to stop the bot from reading html code of emojis
  normalized = normalized.replace(/<\/?[a-zA-Z]+[^>]*>/g, ' ');

  // 3. Clean up HTML entities (e.g. &#128514;, &#x1f600;, &amp;)
  normalized = normalized.replace(/&amp;/g, 'and');
  normalized = normalized.replace(/&#\d+;/g, ' ');
  normalized = normalized.replace(/&#[xX][0-9a-fA-F]+;/g, ' ');
  normalized = normalized.replace(/&[a-zA-Z0-9]+;/g, ' ');

  // Collapse consecutive repeated letters (e.g. laaaaaaaaans -> laans) to prevent letter-by-letter spelling out
  normalized = normalized.replace(/([a-zA-Z])\1{2,}/g, '$1$1');

  // Fix laughing (HAHAHA, hehehe) so it's a unified word and not read as separate letters H-A-H-A-H-A
  normalized = normalized.replace(/\b([hH][aA]){2,}[hH]?\b/g, 'hahaha');
  normalized = normalized.replace(/\b([hH][eE]){2,}[hH]?\b/g, 'hehehe');

  // Expressions
  normalized = normalized.replace(/\b[aA]+[rR]+[gG]+[hH]+\b/g, 'aargh');
  normalized = normalized.replace(/\b[uU]+[gG]+[hH]+\b/g, 'uuugh');

  // Shorthand internet acronyms & tagalog slang
  const slangWords: Record<string, string> = {
    'lol': 'laughing out loud',
    'lmao': 'laughing my ass off',
    'rofl': 'rolling on the floor laughing',
    'omg': 'oh my god',
    'wtf': 'what the fuck',
    'wtheck': 'what the heck',
    'wth': 'what the heck',
    'tldr': 'too long didn\'t read',
    'asap': 'as soon as possible',
    'fyi': 'for your information',
    'jk': 'just kidding',
    'np': 'no problem',
    'omw': 'on my way',
    'rn': 'right now',
    'fr': 'for real',
    'nvm': 'never mind',
    'wdym': 'what do you mean',
    'idc': "I don't care",
    'irl': 'in real life',
    'iykyk': 'if you know you know',
    'wyd': 'what are you doing',
    'hbu': 'how about you',
    'wbu': 'what about you',
    'stfu': 'shut the fuck up',
    'bff': 'best friends forever',
    'ofc': 'of course',
    'idk': "I don't know",
    'brb': 'be right back',
    'afk': 'away from keyboard',
    'tbh': 'to be honest',
    'btw': 'by the way',
    'imo': 'in my opinion',
    'imho': 'in my humble opinion',
    'gg': 'good game',
    'wp': 'well played',
    'smh': 'shaking my head',
    'putangina': 'putang-ina',
    'tangina': 'tang-ina',
    'tngina': 'tang-ina',
    'potangina': 'putang-ina',
    'tanginang': 'tang-inang',
    'putanginang': 'putang-inang',
    'putragis': 'putragis',
    'punyeta': 'punyeta',
    'bobo': 'bobo',
    'obob': 'obob',
    'gago': 'gago',
    'gaga': 'gaga',
    'tanga': 'tanga',
    'lintik': 'lintik',
    'bwisit': 'bwisit',
    'buwisit': 'buwisit',
    'hayop': 'hayop',
    'nako': 'naku',
    'jusko': 'diyos ko',
    'taena': 'tae na',
    'tae': 'tae',
    'putik': 'putik',
    'amputa': 'amputa',
    'ampota': 'amputa',
    'kupal': 'kupal',
    'ulol': 'ulol',
    'lods': 'lodi',
    'char': 'tsar',
    'charot': 'tsa rot',
    'yarn': 'yan',
    'ferson': 'person',
    'omsim': 'mismo',
    'chika': 'tsika',
    'marites': 'ma ri tes',
    'awit': 'a wit',
    'amp': 'am puta',
    'dejk': 'de joke',
    'ge': 'sige',
    'geh': 'sige',
    'slr': 'sorry late reply',
    'jowa': 'dyo wa',
    'syota': 'syo ta',
    'hanep': 'ha nep',
    'lupet': 'lu pit',
    'petmalu': 'malupit',
    'lodi': 'idol',
    'werpa': 'pawer',
    'orb': 'bro',
    'ermat': 'nanay',
    'erpat': 'tatay',
    'tol': 'uto',
    'utol': 'utol',
    'pre': 'pare',
    'pare': 'pare',
    'mare': 'mare',
    'ung': 'yung',
    'nung': 'noong',
    'bkt': 'bakit',
    'bat': 'bakit',
    'sn': 'saan',
    'san': 'saan',
    'pano': 'paano',
    'kelan': 'kailan',
    'kln': 'kailan',
    'gnn': 'ganoon',
    'ganun': 'ganoon',
    'ngyon': 'ngayon',
    'ngyn': 'ngayon',
    'nyo': 'ninyo',
    'nya': 'niya',
    'sya': 'siya',
    'mya': 'mamaya',
    'd': 'hindi',
    'di': 'hindi',
    'wg': 'huwag',
    'wag': 'huwag',
    'hwag': 'huwag',
    'pd': 'pwede',
    'pde': 'pwede',
    'q': 'ko',
    'aq': 'ako',
    'kau': 'kayo',
    'tyo': 'tayo',
    'd2': 'dito',
    'dun': 'doon',
    'dyn': 'diyan',
    'kc': 'kasi',
    'kse': 'kasi',
    'c': 'si',
    'cnu': 'sino',
    'sno': 'sino',
    'gnun': 'ganoon',
    'gnyan': 'ganyan',
    'tlga': 'talaga',
    'khit': 'kahit',
    'cg': 'sige',
    'cge': 'sige',
    'pr': 'pero',
    'pro': 'pero',
    'lng': 'lang',
    'nka': 'naka',
    'nman': 'naman',
    'nmn': 'naman'
  };

  for (const [key, value] of Object.entries(slangWords)) {
    const regex = new RegExp(`\\b${key}\\b`, 'gi');
    normalized = normalized.replace(regex, value);
  }

  // Add pauses for multiple punctuation marks to improve intonation
  normalized = normalized.replace(/([?!.]){2,}/g, '$1'); 
  normalized = normalized.replace(/\\.\\.\\./g, ', ');

  return normalized;
}

export async function testVoice(channelId: string, lang = 'en', text = 'This is a test message to verify the voice channel connection.') {
  console.log(`Running test voice on channel ${channelId} with lang ${lang}`);
  await playAudioInVoiceChannels(text, [channelId], lang, true);
}

export async function playAudioInVoiceChannels(text: string, channelIds: string[], lang = 'en', disableAutoDetect = false) {
  if (!client || !channelIds || channelIds.length === 0) {
    // Fallback to process.env if none specified
    const fallbackId = process.env.DISCORD_VOICE_CHANNEL_ID;
    if (fallbackId) channelIds = [fallbackId];
    else return;
  }

  // Pre-process and normalize text for better TTS reading
  let normalizedText = normalizeTextForTTS(text);

  // Clean and map language code
  let resolvedLang = lang ? lang.toLowerCase().replace('_', '-') : 'en';
  if (resolvedLang === 'fil') {
    resolvedLang = 'tl';
  }
  
  let isTagalogDetected = false;
  // Auto-detect Tagalog/Taglish or enforce explicit profiles
  if (!disableAutoDetect && (resolvedLang.startsWith('tl') || resolvedLang.startsWith('fil') || isTaglishOrTagalog(normalizedText))) {
    isTagalogDetected = true;
    if (resolvedLang !== 'tl-male' && resolvedLang !== 'tl-female') {
      resolvedLang = 'tl-female'; // Revert back to female default
    }
  } else {
    // Standardize and keep valid Google Translate subcodes, otherwise take the 2-letter ISO code.
    const googleSupportsSub = ['en-gb', 'en-us', 'en-au', 'en-ca', 'pt-br', 'zh-cn', 'zh-tw', 'es-es', 'es-mx', 'fr-fr', 'de-de'];
    if (googleSupportsSub.includes(resolvedLang)) {
      // Keep support for regional accents
    } else if (resolvedLang.startsWith('en')) {
      if (resolvedLang !== 'en-male' && resolvedLang !== 'en-female') {
        resolvedLang = 'en-female'; // Default English to female
      }
    } else {
      // Map 'es-AR' -> 'es', 'pt-PT' -> 'pt'
      resolvedLang = resolvedLang.split('-')[0];
    }
  }

  // If Tagalog is selected or detected, replace numbers with English words so the bot reads it in English straight
  if (isTagalogDetected || resolvedLang.startsWith('tl')) {
    normalizedText = replaceNumbersWithEnglishWords(normalizedText);
  }

  debugLog(`Requested TTS broadcast for text: "${text}" into channels: ${channelIds.join(', ')} with resolved lang: "${resolvedLang}"`);

  let audioBuffer: Buffer;
  try {
    let resolvedLangCode = resolvedLang;
    let isMale = false;

    // Map selected language to explicit male/female options per user request
    if (resolvedLang === 'en-male') {
      resolvedLangCode = 'en-US';
      isMale = true;
    } else if (resolvedLang === 'en-female' || resolvedLang === 'en') {
      resolvedLangCode = 'en-US';
    } else if (resolvedLang === 'tl-male') {
      resolvedLangCode = 'tl';
      isMale = true; 
    } else if (resolvedLang === 'tl-female' || resolvedLang === 'tl') {
      resolvedLangCode = 'tl';
    }

    const url = googleTTS.getAudioUrl(normalizedText, {
      lang: resolvedLangCode,
      slow: false,
      host: 'https://translate.google.com',
    });
    debugLog(`Generating Google TTS speech URL: ${url}`);
    
    // Fetch and download TTS file locally via Node's native fetch
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Google TTS request failed with HTTP status ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    audioBuffer = Buffer.from(arrayBuffer);
    debugLog(`Successfully downloaded TTS file. Size: ${audioBuffer.byteLength} bytes. Streaming directly in-memory.`);

    if (isMale) {
      debugLog('Applying FFMPEG pitch shift to sound like a male voice...');
      const tempIn = path.join(os.tmpdir(), `tts-in-${crypto.randomBytes(4).toString('hex')}.mp3`);
      const tempOut = path.join(os.tmpdir(), `tts-out-${crypto.randomBytes(4).toString('hex')}.mp3`);
      fs.writeFileSync(tempIn, audioBuffer);

      await new Promise<void>((resolve, reject) => {
        const { execFile } = require('child_process');
        execFile(ffmpeg as string, [
          '-i', tempIn,
          '-filter:a', 'asetrate=24000*0.75,aresample=24000,atempo=1/0.75', 
          '-y', tempOut
        ], (error: any) => {
          if (error) reject(error);
          else resolve();
        });
      });

      audioBuffer = fs.readFileSync(tempOut);
      fs.unlinkSync(tempIn);
      fs.unlinkSync(tempOut);
      debugLog('FFMPEG pitch shift complete.');
    }
  } catch (err: any) {
    debugLog(`CRITICAL - TTS Download failed: ${err.message}`);
    return;
  }

  for (const channelId of channelIds) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        debugLog(`Channel with ID ${channelId} is not a valid guild voice channel.`);
        continue;
      }

      const connection = getOrCreateVoiceConnection(channel);
      const isReady = await ensureVoiceConnectionReady(connection, channel);
      if (!isReady) {
        continue;
      }

      const player = getOrCreateGuildPlayer(channel.guild.id, connection);
      
      // Optimize: Queue the downloaded audio buffer representing the TTS audio directly to bypassing disk I/O completely
      debugLog(`Enqueuing buffered audio directly in-memory to persistent voice player.`);
      enqueueAudioForGuild(channel.guild.id, {
        type: 'buffer',
        data: audioBuffer
      }, player);
    } catch (error: any) {
      debugLog(`Failed during execution of playAudio in channel ${channelId}: ${error.message}`);
    }
  }
}

export function stopDiscordBot() {
  debugLog("Manual token disengagement triggered: Stopping and destroying all active voice connections...");
  for (const guildId of activeGuildIds) {
    resetDisconnectTimeout(guildId);
    try {
      const connection = getVoiceConnection(guildId);
      if (connection) {
        debugLog(`Destroying active voice connection in guild: ${guildId}`);
        connection.destroy();
      }
    } catch (e: any) {
      debugLog(`Error destroying connection for guild ${guildId}: ${e.message}`);
    }
  }
  activeGuildIds.clear();

  if (client) {
    debugLog("Manual token disengagement triggered: Stopping and destroying current Discord Bot client instance...");
    try {
      client.destroy();
    } catch (e: any) {
      debugLog(`Error while destroying client: ${e.message}`);
    }
    client = null;
  }
}

