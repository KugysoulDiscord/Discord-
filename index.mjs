import { DisTube } from "distube";
import { Client, GatewayIntentBits, Partials, ActivityType, EmbedBuilder, Collection } from "discord.js";
import { SpotifyPlugin } from "@distube/spotify";
import { YtDlpPlugin } from "@distube/yt-dlp";
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs";
import dotenv from "dotenv";
import { execSync } from "child_process";
import fetch from "node-fetch";
import mongoose from "mongoose";
import { setTimeout } from "timers/promises";
import { Manager } from "erela.js"; // Import Erela.js untuk Lavalink
import { 
  joinVoiceChannel, 
  createAudioPlayer, 
  createAudioResource, 
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  getVoiceConnection,
  entersState
} from "@discordjs/voice";

// Load environment variables
dotenv.config();

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('Connected to MongoDB');
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err);
  });

// Create user schema for leveling system
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  guildId: { type: String, required: true },
  xp: { type: Number, default: 0 },
  level: { type: Number, default: 0 },
  lastMessageTimestamp: { type: Date, default: Date.now }
});

// Create welcome message schema
const guildSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  welcomeChannelId: { type: String, default: null },
  welcomeMessage: { type: String, default: "Welcome to the server, {user}!" }
});

// Create models
const User = mongoose.model('User', userSchema);
const Guild = mongoose.model('Guild', guildSchema);

// Get the directory name of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Create cookies.txt file if it doesn't exist or update it with fresh cookies
const cookiesPath = join(__dirname, "cookies.txt");
if (!fs.existsSync(cookiesPath)) {
  // Default YouTube cookies that should work for basic access
  const cookiesContent = `# Netscape HTTP Cookie File
# This file was generated for DisTube Music Bot
# These are default cookies that might help with YouTube access
# You can replace this file with your own cookies if needed

.youtube.com	TRUE	/	TRUE	1782142488	CONSENT	YES+cb.20210328-17-p0.id+FX+299
.youtube.com	TRUE	/	TRUE	1782142488	GPS	1
.youtube.com	TRUE	/	TRUE	1782142488	VISITOR_INFO1_LIVE	4VwPMkB7Tgs
.youtube.com	TRUE	/	TRUE	1782142488	YSC	w_UL1DpzSdU
.youtube.com	TRUE	/	TRUE	1782142488	PREF	f6=40000000&tz=Asia.Jakarta
.youtube.com	TRUE	/	TRUE	1782142488	__Secure-YEC	CgtqUHZEcmRLZWRodyiAhpKnBg%3D%3D`;
  
  fs.writeFileSync(cookiesPath, cookiesContent);
  console.log("Created default cookies.txt file for YouTube access");
}

// AI function using OpenRouter API (using Llama or Gemini models)
async function generateAIResponse(prompt) {
  try {
    // Use Llama model from OpenRouter
    const model = "meta-llama/llama-3-8b-instruct"; // Affordable Llama model
    
    const systemPrompt = `You are a friendly, helpful, and knowledgeable AI assistant in a Discord server.

Guidelines:
- Be conversational, warm, and engaging while maintaining a helpful tone
- Provide concise but informative responses
- Use appropriate emojis occasionally to make your responses more engaging
- Be respectful and considerate of all users
- If you don't know something, be honest about it
- Avoid controversial topics and maintain a positive atmosphere
- Adapt your tone to match the user's query - be professional for serious questions and more casual for light conversation
- Format your responses clearly with spacing between paragraphs for readability

Remember that you're here to assist users in a friendly and helpful manner!`;
    
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt }
        ],
        max_tokens: 500
      })
    });

    const data = await response.json();
    
    if (data.error) {
      console.error("OpenRouter API error:", data.error);
      return "Sorry, I encountered an error while processing your request.";
    }
    
    return data.choices[0].message.content.trim();
  } catch (error) {
    console.error("AI generation error:", error);
    return "Sorry, I encountered an error while processing your request.";
  }
}

// Function to add XP to a user
async function addXP(userId, guildId, xpToAdd = 5) {
  try {
    // Find the user in the database or create a new one
    let user = await User.findOne({ userId, guildId });
    
    // If user doesn't exist, create a new one
    if (!user) {
      user = new User({ userId, guildId });
    }
    
    // Check if enough time has passed since the last message (to prevent spam)
    const now = new Date();
    const timeDiff = now - user.lastMessageTimestamp;
    if (timeDiff < 60000) { // 1 minute cooldown
      return null;
    }
    
    // Update user's XP and timestamp
    user.xp += xpToAdd;
    user.lastMessageTimestamp = now;
    
    // Calculate level based on XP (simple formula: level = sqrt(xp / 100))
    const newLevel = Math.floor(Math.sqrt(user.xp / 100));
    
    // Check if user leveled up
    const leveledUp = newLevel > user.level;
    if (leveledUp) {
      user.level = newLevel;
    }
    
    // Save the user
    await user.save();
    
    return leveledUp ? user.level : null;
  } catch (error) {
    console.error("Error adding XP:", error);
    return null;
  }
}

// Create a new client instance with properly defined intents
const client = new Client({
  partials: [
    Partials.Channel,
    Partials.GuildMember,
    Partials.User,
  ],
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildIntegrations,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildPresences,
  ],
});

// Global state to track bot status
const globalState = {
  isPlaying: false,
  isPaused: false,
  volume: 50,
  queue: [],
  currentTrack: null,
  loopMode: "off", // off, song, queue
  ffmpegStatus: "unknown",
  voiceConnectionStatus: "disconnected",
  guildId: null,
  radioPlayers: new Map(), // Map to store radio players for each guild
};

// Check if FFmpeg is installed
async function checkFFmpeg() {
  try {
    try {
      execSync("ffmpeg -version", { stdio: "ignore" });
      globalState.ffmpegStatus = "configured";
      console.log("FFmpeg is installed and configured.");
    } catch (error) {
      globalState.ffmpegStatus = "missing";
      console.error("FFmpeg is not installed or not in PATH.");
      console.error("Please install FFmpeg to use audio features.");
    }
  } catch (error) {
    console.error("Error checking FFmpeg:", error);
  }
}

// Call the function to check FFmpeg
checkFFmpeg();

// Radio functions
function createRadioPlayer(url) {
  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Play,
    },
  });
  
  const resource = createAudioResource(url);
  player.play(resource);
  
  // Handle player state changes
  player.on(AudioPlayerStatus.Idle, () => {
    // If the stream ends, recreate it (for continuous playback)
    const newResource = createAudioResource(url);
    player.play(newResource);
  });
  
  player.on('error', error => {
    console.error(`Error with radio player: ${error.message}`);
    // Try to reconnect
    const newResource = createAudioResource(url);
    player.play(newResource);
  });
  
  return player;
}

function playRadio(message, url, radioName) {
  // Check if user is in a voice channel
  const voiceChannel = message.member.voice.channel;
  if (!voiceChannel) {
    return message.reply('❌ You need to be in a voice channel to play radio!');
  }
  
  try {
    // Check if there's already a connection in this guild
    let connection = getVoiceConnection(message.guild.id);
    
    // If there's a connection but it's for DisTube, destroy it first
    if (connection && !globalState.radioPlayers.has(message.guild.id)) {
      connection.destroy();
      connection = null;
    }
    
    // If no connection exists, create one
    if (!connection) {
      connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
      });
      
      // Handle connection state changes
      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          // Try to reconnect
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch (error) {
          // If we can't reconnect, destroy the connection
          connection.destroy();
          globalState.radioPlayers.delete(message.guild.id);
        }
      });
    }
    
    // Create a player if one doesn't exist for this guild
    if (!globalState.radioPlayers.has(message.guild.id)) {
      const player = createRadioPlayer(url);
      globalState.radioPlayers.set(message.guild.id, { player, radioName });
      
      // Subscribe the connection to the player
      connection.subscribe(player);
      
      // Create an embed for the radio
      const radioEmbed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle(`📻 Radio Started: ${radioName}`)
        .setDescription(`Now playing ${radioName} in ${voiceChannel.name}`)
        .setFooter({ text: 'Use !stop to stop the radio' })
        .setTimestamp();
      
      message.reply({ embeds: [radioEmbed] });
    } else {
      // If a player exists, update it with the new radio
      const { player } = globalState.radioPlayers.get(message.guild.id);
      player.stop();
      
      const resource = createAudioResource(url);
      player.play(resource);
      
      // Update the radio info
      globalState.radioPlayers.set(message.guild.id, { player, radioName });
      
      // Create an embed for the radio change
      const radioEmbed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle(`📻 Radio Changed: ${radioName}`)
        .setDescription(`Now playing ${radioName} in ${voiceChannel.name}`)
        .setFooter({ text: 'Use !stop to stop the radio' })
        .setTimestamp();
      
      message.reply({ embeds: [radioEmbed] });
    }
  } catch (error) {
    console.error('Error playing radio:', error);
    message.reply('❌ An error occurred while trying to play the radio.');
  }
}

function stopRadio(message) {
  // Check if there's a radio player for this guild
  if (!globalState.radioPlayers.has(message.guild.id)) {
    return message.reply('❌ No radio is currently playing!');
  }
  
  try {
    // Get the connection
    const connection = getVoiceConnection(message.guild.id);
    if (connection) {
      // Destroy the connection
      connection.destroy();
    }
    
    // Remove the player from the map
    globalState.radioPlayers.delete(message.guild.id);
    
    // Create an embed for stopping the radio
    const stopEmbed = new EmbedBuilder()
      .setColor(0x3498DB)
      .setTitle('📻 Radio Stopped')
      .setDescription('The radio has been stopped.')
      .setTimestamp();
    
    message.reply({ embeds: [stopEmbed] });
  } catch (error) {
    console.error('Error stopping radio:', error);
    message.reply('❌ An error occurred while trying to stop the radio.');
  }
}

// Function to manually update YouTube cookies
function updateYouTubeCookies(cookieString) {
  try {
    // Parse the cookie string into Netscape cookie format
    const cookies = cookieString.split(';').map(cookie => {
      const [name, value] = cookie.trim().split('=');
      if (!name || !value) return null;
      
      return `.youtube.com\tTRUE\t/\tTRUE\t1782142488\t${name}\t${value}`;
    }).filter(Boolean);
    
    if (cookies.length === 0) {
      return false;
    }
    
    // Add header to the cookies file
    const cookiesContent = `# Netscape HTTP Cookie File
# This file was manually updated for DisTube Music Bot
# Updated on ${new Date().toISOString()}

${cookies.join('\n')}`;
    
    fs.writeFileSync(cookiesPath, cookiesContent);
    console.log("YouTube cookies updated successfully!");
    return true;
  } catch (error) {
    console.error("Error updating YouTube cookies:", error);
    return false;
  }
}

// Function to get YouTube video info using YouTube Data API v3
async function getYouTubeVideoInfo(videoId) {
  try {
    // Use YouTube Data API v3 instead of Innertube API
    const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
    
    if (!YOUTUBE_API_KEY) {
      throw new Error("YouTube API key is not configured. Please set YOUTUBE_API_KEY in your .env file.");
    }
    
    // Get video details using YouTube Data API
    const videoResponse = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=snippet,contentDetails,statistics&key=${YOUTUBE_API_KEY}`
    );
    
    const videoData = await videoResponse.json();
    
    // Check if we got a valid response
    if (!videoData || !videoData.items || videoData.items.length === 0) {
      throw new Error("Video not found or API quota exceeded");
    }
    
    // Get video details
    const video = videoData.items[0];
    const title = video.snippet.title;
    const author = video.snippet.channelTitle;
    
    // Convert ISO 8601 duration to seconds
    const duration = video.contentDetails.duration;
    const durationInSeconds = convertISO8601ToSeconds(duration);
    
    // Get thumbnail (highest quality available)
    const thumbnails = video.snippet.thumbnails;
    const thumbnail = thumbnails.maxres?.url || 
                     thumbnails.high?.url || 
                     thumbnails.medium?.url || 
                     thumbnails.default?.url ||
                     `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
    
    console.log(`✅ Successfully retrieved video info for "${title}" by ${author} using YouTube Data API`);
    
    // Return video information in the same format as before
    return {
      url: `https://www.youtube.com/watch?v=${videoId}`, // We don't get direct audio URL from Data API
      title: title,
      author: author,
      duration: durationInSeconds,
      thumbnail: thumbnail,
      viewCount: video.statistics.viewCount,
      videoId: videoId
    };
  } catch (error) {
    console.error("Error getting YouTube video info:", error);
    throw error;
  }
}

// Helper function to convert ISO 8601 duration to seconds
function convertISO8601ToSeconds(duration) {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  
  const hours = parseInt(match[1] || 0);
  const minutes = parseInt(match[2] || 0);
  const seconds = parseInt(match[3] || 0);
  
  return hours * 3600 + minutes * 60 + seconds;
}

// Helper function to format duration in HH:MM:SS format
function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  } else {
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }
}

// Helper function to format numbers with commas
function formatNumber(num) {
  return parseInt(num).toLocaleString();
}

// Function to check if a URL is a YouTube URL and extract the video ID
function extractYouTubeVideoId(url) {
  const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
  const match = url.match(regex);
  return match ? match[1] : null;
}

// Create a new DisTube instance with proper options for DisTube v5
const distube = new DisTube(client, {
  nsfw: false,
  emitNewSongOnly: true,
  plugins: [
    new SpotifyPlugin({
      api: {
        clientId: process.env.SPOTIFY_CLIENT_ID || "0e7b9b46993d4a9ab295da2da2dc5909",
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET || "e2199abf29f84e8aa05269aa3710e6ae",
      }
    }),
    new YtDlpPlugin({
      update: false,
      cookies: cookiesPath, // Use cookies for YouTube access
    }),
  ],
});

// Inisialisasi Lavalink Manager
const manager = new Manager({
  // Konfigurasi node Lavalink
  nodes: [
    {
      host: process.env.LAVALINK_HOST || "localhost", // Menggunakan host dari env atau default
      port: parseInt(process.env.LAVALINK_PORT) || 2333, // Port default Lavalink
      password: process.env.LAVALINK_PASSWORD || "youshallnotpass", // Password dari env atau default
      secure: false,     // Gunakan true jika menggunakan SSL
      requestTimeout: 30000, // Timeout untuk request (30 detik)
      retryAmount: 5,    // Jumlah percobaan ulang jika gagal
      retryDelay: 3000,  // Delay antar percobaan (3 detik)
    },
  ],
  // Fungsi untuk mengirim data ke Discord
  send: (id, payload) => {
    const guild = client.guilds.cache.get(id);
    if (guild) guild.shard.send(payload);
  },
  // Gunakan YouTube dan Spotify sebagai sumber
  autoPlay: true,
  // Konfigurasi Spotify
  spotify: {
    clientId: process.env.SPOTIFY_CLIENT_ID || "0e7b9b46993d4a9ab295da2da2dc5909",
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || "e2199abf29f84e8aa05269aa3710e6ae"
  },
});

// Helper function to format duration for Lavalink
// Function to format duration for Lavalink tracks (milliseconds)
function formatLavaDuration(ms) {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor(ms / (1000 * 60 * 60));

  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
    : `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// Set up event listeners for DisTube
distube
  .on("playSong", (queue, song) => {
    globalState.isPlaying = true;
    globalState.isPaused = false;
    globalState.currentTrack = {
      title: song.name,
      url: song.url,
      thumbnail: song.thumbnail,
      duration: song.formattedDuration,
      author: song.uploader?.name || "Unknown",
    };
    
// Set up event listeners for Lavalink
manager
  .on("nodeConnect", (node) => {
    console.log(`✅ Lavalink node ${node.options.identifier} connected successfully.`);
    
    // Send connection status to all guilds with active text channels
    client.guilds.cache.forEach(guild => {
      // Find a suitable text channel to send the message (system channel or first text channel)
      const channel = guild.systemChannel || 
                     guild.channels.cache.find(ch => 
                       ch.type === ChannelType.GuildText && 
                       ch.permissionsFor(guild.members.me).has(PermissionsBitField.Flags.SendMessages)
                     );
      
      if (channel) {
        const embed = new EmbedBuilder()
          .setColor(0x00FF00)
          .setTitle("✅ Lavalink Connected")
          .setDescription(`Successfully connected to Lavalink node: ${node.options.host}:${node.options.port}`)
          .addFields(
            { name: "Node", value: node.options.identifier || "main", inline: true },
            { name: "Status", value: "Online", inline: true }
          )
          .setTimestamp()
          .setFooter({ text: "Music system is now fully operational" });
        
        channel.send({ embeds: [embed] }).catch(err => 
          console.error(`Could not send Lavalink connection message to ${guild.name}: ${err.message}`)
        );
      }
    });
  })
  .on("nodeError", (node, error) => {
    console.error(`❌ Lavalink node ${node.options.identifier} had an error: ${error.message}`);
    
    // Notify about the error in guilds
    client.guilds.cache.forEach(guild => {
      const channel = guild.systemChannel || 
                     guild.channels.cache.find(ch => 
                       ch.type === ChannelType.GuildText && 
                       ch.permissionsFor(guild.members.me).has(PermissionsBitField.Flags.SendMessages)
                     );
      
      if (channel) {
        const embed = new EmbedBuilder()
          .setColor(0xFF0000)
          .setTitle("❌ Lavalink Connection Error")
          .setDescription(`Error connecting to Lavalink node: ${node.options.host}:${node.options.port}`)
          .addFields(
            { name: "Error", value: error.message, inline: false }
          )
          .setTimestamp()
          .setFooter({ text: "Music system may not function properly" });
        
        channel.send({ embeds: [embed] }).catch(err => 
          console.error(`Could not send Lavalink error message to ${guild.name}: ${err.message}`)
        );
      }
    });
  })
  .on("trackStart", (player, track) => {
    const channel = client.channels.cache.get(player.textChannel);
    if (channel) {
      const embed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle("🎵 Now Playing")
        .setDescription(`[${track.title}](${track.uri})`)
        .setThumbnail(track.thumbnail || track.displayThumbnail())
        .addFields(
          { name: "Duration", value: formatLavaDuration(track.duration), inline: true },
          { name: "Requested By", value: track.requester.tag, inline: true }
        )
        .setTimestamp();
      
      channel.send({ embeds: [embed] });
    }
    
    globalState.isPlaying = true;
    globalState.isPaused = false;
    globalState.currentTrack = {
      title: track.title,
      url: track.uri,
      thumbnail: track.thumbnail || track.displayThumbnail(),
      duration: track.duration,
      author: track.author || "Unknown",
    };
  })
  .on("queueEnd", (player) => {
    const channel = client.channels.cache.get(player.textChannel);
    if (channel) {
      channel.send("✅ Queue has ended! Add more songs to keep the party going!");
    }
    
    globalState.isPlaying = false;
    globalState.isPaused = false;
    globalState.currentTrack = null;
    globalState.queue = [];
  })
  .on("playerMove", (player, oldChannel, newChannel) => {
    if (!newChannel) {
      player.destroy();
      const channel = client.channels.cache.get(player.textChannel);
      if (channel) {
        channel.send("❌ I've been disconnected from the voice channel.");
      }
    }
  });
    globalState.queue = queue.songs.slice(1).map(s => ({
      title: s.name,
      url: s.url,
      thumbnail: s.thumbnail,
      duration: s.formattedDuration,
      author: s.uploader?.name || "Unknown",
    }));
    globalState.guildId = queue.id;
    globalState.voiceConnectionStatus = "connected";
    
    queue.textChannel.send(
      `🎵 Playing: **${song.name}** - \`${song.formattedDuration}\` - Requested by ${song.user}`
    );
  })
  .on("addSong", (queue, song) => {
    globalState.queue = queue.songs.slice(1).map(s => ({
      title: s.name,
      url: s.url,
      thumbnail: s.thumbnail,
      duration: s.formattedDuration,
      author: s.uploader?.name || "Unknown",
    }));
    
    queue.textChannel.send(
      `✅ Added **${song.name}** - \`${song.formattedDuration}\` to the queue by ${song.user}`
    );
  })
  .on("addList", (queue, playlist) => {
    globalState.queue = queue.songs.slice(1).map(s => ({
      title: s.name,
      url: s.url,
      thumbnail: s.thumbnail,
      duration: s.formattedDuration,
      author: s.uploader?.name || "Unknown",
    }));
    
    queue.textChannel.send(
      `✅ Added **${playlist.name}** playlist (${playlist.songs.length} songs) to queue`
    );
  })
  .on("error", async (channel, error) => {
    console.error("DisTube error:", error);
    
    // Check if the error is related to YouTube bot detection
    if (error.message && error.message.includes("Sign in to confirm you're not a bot")) {
      if (channel) {
        channel.send(`❌ YouTube is asking for verification. Trying to use Innertube API instead...`);
      }
      
      // Try to get the video ID from the error message
      const errorMessage = error.message;
      const urlMatch = errorMessage.match(/(https?:\/\/[^\s]+)/);
      
      if (urlMatch && urlMatch[1]) {
        const url = urlMatch[1];
        const videoId = extractYouTubeVideoId(url);
        
        if (videoId) {
          try {
            // Get video info using Innertube API
            const videoInfo = await getYouTubeVideoInfo(videoId);
            
            if (channel) {
              channel.send(`✅ Successfully retrieved video info using Innertube API. Attempting to play...`);
              
              // Try to play the video using the direct URL
              const queue = distube.getQueue(channel.guild);
              if (queue) {
                // If there's a queue, add the song to it
                // This is a simplified implementation and might need more work
                channel.send(`⚠️ Innertube API implementation is experimental. Please report any issues.`);
              } else {
                channel.send(`⚠️ Innertube API implementation is experimental. Please try again with the command.`);
              }
            }
          } catch (innertubeError) {
            console.error("Innertube API error:", innertubeError);
            
            if (channel) {
              channel.send(`❌ Failed to use Innertube API. Please try using the \`!cookies\` command to update your YouTube cookies.
              
**How to get your YouTube cookies:**
1. Login to YouTube in your browser
2. Open Developer Tools (F12 or right-click > Inspect)
3. Go to the "Application" or "Storage" tab
4. Find "Cookies" > "youtube.com"
5. Look for cookies like VISITOR_INFO1_LIVE, CONSENT, etc.
6. Use \`!cookies VISITOR_INFO1_LIVE=value; CONSENT=value; etc.\` to update`);
            }
          }
        } else if (channel) {
          channel.send(`❌ Could not extract video ID from the URL. Please try using the \`!cookies\` command.`);
        }
      } else if (channel) {
        channel.send(`❌ Could not extract URL from the error message. Please try using the \`!cookies\` command.`);
      }
    } else if (channel) {
      channel.send(`❌ Error: ${error.message}`);
    }
  })
  .on("finish", queue => {
    globalState.isPlaying = false;
    globalState.currentTrack = null;
    globalState.queue = [];
    
    queue.textChannel.send("🏁 Queue finished!");
  })
  .on("disconnect", queue => {
    globalState.voiceConnectionStatus = "disconnected";
    globalState.isPlaying = false;
    globalState.currentTrack = null;
    globalState.queue = [];
    
    queue.textChannel.send("👋 Disconnected from voice channel");
  })
  .on("empty", queue => {
    queue.textChannel.send("⚠️ Voice channel is empty! Leaving the channel in 5 minutes unless someone joins.");
  })
  .on("initQueue", queue => {
    queue.autoplay = false;
    queue.volume = 50;
    globalState.loopMode = queue.repeatMode === 0 ? "off" : queue.repeatMode === 1 ? "track" : "queue";
  })
  .on("pause", queue => {
    globalState.isPaused = true;
    globalState.isPlaying = false;
    queue.textChannel.send("⏸️ Music paused");
  })
  .on("resume", queue => {
    globalState.isPaused = false;
    globalState.isPlaying = true;
    queue.textChannel.send("▶️ Music resumed");
  })
  .on("noRelated", queue => {
    queue.textChannel.send("❌ Can't find related video to play");
  })
  .on("searchCancel", message => {
    message.channel.send("❌ Searching canceled");
  })
  .on("searchNoResult", message => {
    message.channel.send("❌ No result found!");
  })
  .on("searchResult", (message, results) => {
    message.channel.send(
      `**Choose an option from below**\n${results
        .map((song, i) => `**${i + 1}**. ${song.name} - \`${song.formattedDuration}\``)
        .join("\n")}\n*Enter anything else or wait 60 seconds to cancel*`
    );
  })
  .on("searchDone", () => {})
  .on("searchInvalidAnswer", message => {
    message.channel.send("❌ Invalid number of result");
  })
  .on("searchCancelled", message => {
    message.channel.send("❌ Searching canceled");
  });

// When the client is ready, run this code (only once)
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}!`);
  
  // Set the bot's activity
  client.user.setPresence({
    activities: [{ name: "!help for commands", type: ActivityType.Listening }],
    status: "online",
  });
  
  // Initialize Lavalink
  manager.init(client.user.id);
  console.log("Lavalink manager initialized");
  
  // Load YouTube cookies for DisTube if available
  if (fs.existsSync('./cookies.txt')) {
    try {
      const cookiesContent = fs.readFileSync('./cookies.txt', 'utf8');
      console.log("YouTube cookies file found, applying to DisTube");
      // Update DisTube's YouTube cookies
      if (distube.options && distube.options.youtubeDL) {
        distube.options.youtubeDL.cookies = cookiesContent;
      }
    } catch (error) {
      console.error("Error loading YouTube cookies:", error);
    }
  }
  
  // Check and create guild settings for all guilds
  client.guilds.cache.forEach(async (guild) => {
    try {
      const guildSettings = await Guild.findOne({ guildId: guild.id });
      if (!guildSettings) {
        const newGuild = new Guild({ guildId: guild.id });
        await newGuild.save();
        console.log(`Created settings for guild: ${guild.name}`);
      }
    } catch (error) {
      console.error(`Error creating settings for guild ${guild.name}:`, error);
    }
  });
});

// Handle new guild members (welcome message)
client.on("guildMemberAdd", async (member) => {
  try {
    // Get guild settings
    const guildSettings = await Guild.findOne({ guildId: member.guild.id });
    
    // If no settings or no welcome channel set, return
    if (!guildSettings || !guildSettings.welcomeChannelId) return;
    
    // Get the welcome channel
    const welcomeChannel = member.guild.channels.cache.get(guildSettings.welcomeChannelId);
    if (!welcomeChannel) return;
    
    // Replace placeholders in welcome message
    const welcomeMessage = guildSettings.welcomeMessage
      .replace(/{user}/g, `<@${member.id}>`)
      .replace(/{username}/g, member.user.username)
      .replace(/{server}/g, member.guild.name)
      .replace(/{membercount}/g, member.guild.memberCount);
    
    // Create a welcome embed
    const welcomeEmbed = new EmbedBuilder()
      .setColor(0x3498DB)
      .setTitle(`Welcome to ${member.guild.name}!`)
      .setDescription(welcomeMessage)
      .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
      .setFooter({ text: `Member #${member.guild.memberCount}` })
      .setTimestamp();
    
    // Send the welcome message
    welcomeChannel.send({ embeds: [welcomeEmbed] });
  } catch (error) {
    console.error("Error sending welcome message:", error);
  }
});

// Create a message event listener
// Forward raw events to Lavalink
client.on("raw", (d) => manager.updateVoiceState(d));

client.on("messageCreate", async message => {
  // Ignore messages from bots
  if (message.author.bot) return;
  
  // Handle XP and leveling for regular messages
  if (message.guild) {
    const leveledUp = await addXP(message.author.id, message.guild.id);
    if (leveledUp) {
      const levelEmbed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('Level Up!')
        .setDescription(`Congratulations ${message.author}! You've reached level **${leveledUp}**!`)
        .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
        .setTimestamp();
      
      message.channel.send({ embeds: [levelEmbed] });
    }
  }
  
  // Check if the message starts with the prefix
  const prefix = "!";
  if (!message.content.startsWith(prefix)) return;
  
  // Parse the command and arguments
  const args = message.content.slice(prefix.length).trim().split(/ +/g);
  const command = args.shift().toLowerCase();
  
  // Handle commands
  switch (command) {
    case "play":
    case "p":
      if (!message.member.voice.channel) {
        return message.reply("❌ You need to be in a voice channel to play music!");
      }
      
      if (!args.length) {
        return message.reply("❌ Please provide a song URL or search query!");
      }
      
      // Send a loading message
      const loadingMessage = await message.channel.send(`🔍 Searching for: ${args.join(" ")}`);
      
      try {
        let query = args.join(" ");
        
        // Handle Spotify URI format (spotify:track:id, spotify:album:id, spotify:playlist:id)
        if (query.startsWith("spotify:")) {
          const parts = query.split(":");
          if (parts.length === 3) {
            const [_, type, id] = parts;
            if (["track", "album", "playlist"].includes(type)) {
              query = `https://open.spotify.com/${type}/${id}`;
              await loadingMessage.edit(`🎵 Converting Spotify URI to URL: ${query}`);
            }
          }
        }
        // Process Spotify URLs for better compatibility
        else if (query.includes("open.spotify.com")) {
          // Extract the clean Spotify URL without extra parameters
          const spotifyUrlMatch = query.match(/(https:\/\/open\.spotify\.com\/(?:track|album|playlist)\/[a-zA-Z0-9]+)/);
          if (spotifyUrlMatch && spotifyUrlMatch[1]) {
            query = spotifyUrlMatch[1];
            await loadingMessage.edit(`🎵 Detected Spotify URL, optimizing format: ${query}`);
          }
        }
        
        // Update loading message to show we're using Lavalink
        await loadingMessage.edit("🔄 Using Lavalink music system...")
        
        // Try to use Lavalink first (if available)
        try {
          // Get or create a player
          const player = manager.players.get(message.guild.id) || manager.create({
            guild: message.guild.id,
            voiceChannel: message.member.voice.channel.id,
            textChannel: message.channel.id,
          });
          
          // Connect to the voice channel
          player.connect();
          
          // Search for the song
          const res = await manager.search(query, message.author);
          
          // Handle search results based on load type
          switch (res.loadType) {
            case "LOAD_FAILED":
              throw new Error(`Failed to load track: ${res.exception?.message || "Unknown error"}`);
              
            case "NO_MATCHES":
              throw new Error("No matches found for your query");
              
            case "PLAYLIST_LOADED":
              // Add all tracks from playlist
              player.queue.add(res.tracks);
              
              // Create a rich embed for the playlist
              const playlistEmbed = new EmbedBuilder()
                .setColor(0x3498DB)
                .setTitle(`🎵 Added Playlist to Queue`)
                .setDescription(`**${res.playlist.name}** with ${res.tracks.length} tracks`)
                .setThumbnail(res.tracks[0].thumbnail || "https://i.imgur.com/4M7IWwP.png")
                .addFields(
                  { name: "Tracks", value: `${res.tracks.length} songs`, inline: true },
                  { name: "Requested By", value: message.author.tag, inline: true }
                )
                .setTimestamp();
              
              // Update the loading message with the embed
              await loadingMessage.edit({ content: "", embeds: [playlistEmbed] });
              
              // Play the track if not already playing
              if (!player.playing && !player.paused && !player.queue.size) {
                player.play();
              }
              return; // Exit early since we successfully used Lavalink
              
            default: // TRACK_LOADED or SEARCH_RESULT
              const track = res.tracks[0];
              player.queue.add(track);
              
              // Create a rich embed for the track
              const trackEmbed = new EmbedBuilder()
                .setColor(0x3498DB)
                .setTitle(`🎵 Added to Queue`)
                .setDescription(`[${track.title}](${track.uri})`)
                .setThumbnail(track.thumbnail || "https://i.imgur.com/4M7IWwP.png")
                .addFields(
                  { name: "Duration", value: formatLavaDuration(track.duration), inline: true },
                  { name: "Requested By", value: message.author.tag, inline: true }
                )
                .setTimestamp();
              
              // Update the loading message with the embed
              await loadingMessage.edit({ content: "", embeds: [trackEmbed] });
              
              // Play the track if not already playing
              if (!player.playing && !player.paused && !player.queue.size) {
                player.play();
              }
              return; // Exit early since we successfully used Lavalink
          }
        } catch (lavaError) {
          console.error("Lavalink error:", lavaError);
          
          // Update the loading message with the error
          await loadingMessage.edit(`❌ Lavalink error: ${lavaError.message}`);
          
          // Only fall back to DisTube if absolutely necessary
          if (lavaError.message.includes("No matches found") || 
              lavaError.message.includes("Failed to load track") ||
              lavaError.message.includes("Lavalink search failed")) {
            
            await loadingMessage.edit("⚠️ Lavalink couldn't find the track. Trying with DisTube as fallback...");
            
            try {
              await distube.play(message.member.voice.channel, query, {
                member: message.member,
                textChannel: message.channel,
                message,
              });
              
              // If DisTube succeeds, update the message
              await loadingMessage.edit("✅ Successfully played with DisTube fallback system");
              return; // Exit early since we successfully used DisTube
            } catch (distubeError) {
              console.error("DisTube error:", distubeError);
              await loadingMessage.edit(`❌ Both Lavalink and DisTube failed: ${distubeError.message}`);
              return; // Exit early since both systems failed
            }
          }
          return; // Exit early if we're not falling back to DisTube
        }
        
        // Fall back to DisTube if Lavalink fails
        // Check if it's a YouTube URL and we should try Innertube API first
        const url = args.join(" ");
        const videoId = extractYouTubeVideoId(url);
        
        if (videoId) {
          try {
            // Try to get video info using Innertube API first
            const videoInfo = await getYouTubeVideoInfo(videoId);
            
            // Create a rich embed with video information
            const embed = new EmbedBuilder()
              .setColor('#FF0000')
              .setTitle(videoInfo.title)
              .setURL(videoInfo.url)
              .setAuthor({ name: 'YouTube', iconURL: 'https://www.youtube.com/s/desktop/3a84d4c0/img/favicon_144x144.png' })
              .setDescription(`By: ${videoInfo.author}`)
              .setThumbnail(videoInfo.thumbnail)
              .addFields(
                { name: 'Duration', value: formatDuration(videoInfo.duration), inline: true },
                { name: 'Views', value: formatNumber(videoInfo.viewCount), inline: true }
              )
              .setFooter({ text: 'Powered by YouTube Data API' });
            
            message.channel.send({ embeds: [embed] });
            message.channel.send(`✅ Successfully retrieved video info using YouTube Data API. Attempting to play...`);
            
            // Continue with normal DisTube play as it should work now
            await distube.play(message.member.voice.channel, url, {
              member: message.member,
              textChannel: message.channel,
              message,
            });
          } catch (youtubeApiError) {
            console.error("YouTube API error:", youtubeApiError);
            
            // Check if it's an API key issue
            if (youtubeApiError.message.includes("API key is not configured")) {
              message.channel.send(`❌ YouTube API key is not configured. Please ask the bot owner to set up the YouTube API key.`);
              return;
            }
            
            // Check if it's a quota exceeded issue
            if (youtubeApiError.message.includes("API quota exceeded")) {
              message.channel.send(`⚠️ YouTube API quota exceeded. Falling back to normal playback...`);
            } else {
              message.channel.send(`⚠️ YouTube API error: ${youtubeApiError.message}. Falling back to normal playback...`);
            }
            
            // Fall back to normal DisTube play
            await distube.play(message.member.voice.channel, url, {
              member: message.member,
              textChannel: message.channel,
              message,
            });
          }
        } else {
          // Check if it's a Spotify URL and format it correctly
          let query = args.join(" ");
          
          // Check for Spotify URL patterns
          if (query.includes("open.spotify.com")) {
            // Extract the clean Spotify URL without extra parameters
            const spotifyUrlMatch = query.match(/(https:\/\/open\.spotify\.com\/(?:track|album|playlist)\/[a-zA-Z0-9]+)/);
            if (spotifyUrlMatch && spotifyUrlMatch[1]) {
              query = spotifyUrlMatch[1];
              message.channel.send(`🎵 Detected Spotify URL, optimizing format: ${query}`);
            }
          }
          
          // Remove any "spotify:" prefix if present
          if (query.startsWith("spotify:")) {
            query = query.replace("spotify:", "");
            message.channel.send(`🎵 Removed 'spotify:' prefix for better compatibility`);
          }
          
          // Not a YouTube URL, use normal DisTube play with possibly reformatted query
          await distube.play(message.member.voice.channel, query, {
            member: message.member,
            textChannel: message.channel,
            message,
          });
        }
      } catch (error) {
        console.error("Play error:", error);
        
        // Check if the error is related to YouTube bot detection
        if (error.message && error.message.includes("Sign in to confirm you're not a bot")) {
          message.reply(`❌ YouTube is asking for verification. Please use the \`!cookies\` command to update your YouTube cookies.
          
**How to get your YouTube cookies:**
1. Login to YouTube in your browser
2. Open Developer Tools (F12 or right-click > Inspect)
3. Go to the "Application" or "Storage" tab
4. Find "Cookies" > "youtube.com"
5. Look for cookies like VISITOR_INFO1_LIVE, CONSENT, etc.
6. Use \`!cookies VISITOR_INFO1_LIVE=value; CONSENT=value; etc.\` to update`);
        } else {
          message.reply(`❌ Error: ${error.message}`);
        }
      }
      break;
      
    case "cookies":
      if (!args.length) {
        return message.reply(`❌ Please provide your YouTube cookies!
        
**How to get your YouTube cookies:**
1. Login to YouTube in your browser
2. Open Developer Tools (F12 or right-click > Inspect)
3. Go to the "Application" or "Storage" tab
4. Find "Cookies" > "youtube.com"
5. Look for cookies like VISITOR_INFO1_LIVE, CONSENT, etc.
6. Use \`!cookies VISITOR_INFO1_LIVE=value; CONSENT=value; etc.\` to update`);
      }
      
      const cookieString = args.join(" ");
      const updated = updateYouTubeCookies(cookieString);
      
      if (updated) {
        message.reply("✅ YouTube cookies updated successfully! Try playing music again.");
      } else {
        message.reply("❌ Failed to update YouTube cookies. Please make sure you provided valid cookies.");
      }
      break;
      
    case "stop":
      if (!message.member.voice.channel) {
        return message.reply("❌ You need to be in a voice channel to stop music!");
      }
      
      // Try to stop Lavalink player first
      const lavaPlayer = manager.players.get(message.guild.id);
      if (lavaPlayer) {
        lavaPlayer.destroy();
        message.channel.send("⏹️ Music stopped! (Lavalink)");
        break;
      }
      
      // Fall back to DisTube if no Lavalink player
      const queue = distube.getQueue(message);
      if (!queue) {
        return message.reply("❌ There is nothing playing!");
      }
      
      queue.stop();
      message.channel.send("⏹️ Music stopped! (DisTube)");
      break;
      
    case "skip":
    case "s":
      if (!message.member.voice.channel) {
        return message.reply("❌ You need to be in a voice channel to skip music!");
      }
      
      // Try to skip with Lavalink first
      const lavaSkipPlayer = manager.players.get(message.guild.id);
      if (lavaSkipPlayer) {
        try {
          lavaSkipPlayer.stop();
          message.channel.send("⏭️ Skipped to the next song! (Lavalink)");
          break;
        } catch (error) {
          console.error("Lavalink skip error:", error);
          // Fall back to DisTube if Lavalink skip fails
        }
      }
      
      // Fall back to DisTube if no Lavalink player or if Lavalink skip failed
      const skipQueue = distube.getQueue(message);
      if (!skipQueue) {
        return message.reply("❌ There is nothing playing!");
      }
      
      try {
        skipQueue.skip();
        message.channel.send("⏭️ Skipped to the next song! (DisTube)");
      } catch (error) {
        message.reply(`❌ Error: ${error.message}`);
      }
      break;
      
    case "pause":
      if (!message.member.voice.channel) {
        return message.reply("❌ You need to be in a voice channel to pause music!");
      }
      
      // Try to pause with Lavalink first
      const lavaPausePlayer = manager.players.get(message.guild.id);
      if (lavaPausePlayer) {
        if (lavaPausePlayer.paused) {
          return message.reply("⚠️ The music is already paused! (Lavalink)");
        }
        
        lavaPausePlayer.pause(true);
        message.channel.send("⏸️ Music paused! (Lavalink)");
        break;
      }
      
      // Fall back to DisTube if no Lavalink player
      const pauseQueue = distube.getQueue(message);
      if (!pauseQueue) {
        return message.reply("❌ There is nothing playing!");
      }
      
      if (pauseQueue.paused) {
        return message.reply("⚠️ The music is already paused! (DisTube)");
      }
      
      pauseQueue.pause();
      message.channel.send("⏸️ Music paused! (DisTube)");
      break;
      
    case "resume":
      if (!message.member.voice.channel) {
        return message.reply("❌ You need to be in a voice channel to resume music!");
      }
      
      // Try to resume with Lavalink first
      const lavaResumePlayer = manager.players.get(message.guild.id);
      if (lavaResumePlayer) {
        if (!lavaResumePlayer.paused) {
          return message.reply("⚠️ The music is already playing! (Lavalink)");
        }
        
        lavaResumePlayer.pause(false);
        message.channel.send("▶️ Music resumed! (Lavalink)");
        break;
      }
      
      // Fall back to DisTube if no Lavalink player
      const resumeQueue = distube.getQueue(message);
      if (!resumeQueue) {
        return message.reply("❌ There is nothing to resume!");
      }
      
      if (!resumeQueue.paused) {
        return message.reply("⚠️ The music is already playing! (DisTube)");
      }
      
      resumeQueue.resume();
      message.channel.send("▶️ Music resumed! (DisTube)");
      break;
      
    case "queue":
    case "q":
      // Try to get queue from Lavalink first
      const lavaQueuePlayer = manager.players.get(message.guild.id);
      if (lavaQueuePlayer) {
        const currentTrack = lavaQueuePlayer.queue.current;
        const queue = lavaQueuePlayer.queue;
        
        if (!currentTrack) {
          return message.reply("❌ There is nothing playing! (Lavalink)");
        }
        
        let queueString = `Playing: ${currentTrack.title} - \`${formatLavaDuration(currentTrack.duration)}\` - Requested by ${currentTrack.requester.tag}\n`;
        
        if (queue.length > 0) {
          queueString += queue
            .map(
              (track, i) =>
                `${i + 1}. ${track.title} - \`${formatLavaDuration(track.duration)}\` - Requested by ${track.requester.tag}`
            )
            .join("\n");
        }
        
        message.channel.send(`📋 **Current Queue (Lavalink)**\n${queueString}`);
        break;
      }
      
      // Fall back to DisTube if no Lavalink player
      const queueInfo = distube.getQueue(message);
      if (!queueInfo) {
        return message.reply("❌ There is nothing playing! (DisTube)");
      }
      
      const queueString = queueInfo.songs
        .map(
          (song, i) =>
            `${i === 0 ? "Playing:" : `${i}.`} ${song.name} - \`${song.formattedDuration}\` - Requested by ${song.user}`
        )
        .join("\n");
        
      message.channel.send(`📋 **Current Queue (DisTube)**\n${queueString}`);
      break;
      
    case "loop":
    case "repeat":
      if (!message.member.voice.channel) {
        return message.reply("❌ You need to be in a voice channel to use this command!");
      }
      
      const loopQueue = distube.getQueue(message);
      if (!loopQueue) {
        return message.reply("❌ There is nothing playing!");
      }
      
      let mode = args[0]?.toLowerCase();
      let modeNum;
      
      switch (mode) {
        case "off":
          modeNum = 0;
          break;
        case "song":
        case "track":
        case "s":
        case "t":
          modeNum = 1;
          break;
        case "queue":
        case "q":
          modeNum = 2;
          break;
        default:
          // If no valid mode is provided, cycle through modes
          modeNum = (loopQueue.repeatMode + 1) % 3;
      }
      
      loopQueue.setRepeatMode(modeNum);
      globalState.loopMode = modeNum === 0 ? "off" : modeNum === 1 ? "track" : "queue";
      
      const modeStrings = ["Off", "Song", "Queue"];
      message.channel.send(`🔄 Loop mode set to: **${modeStrings[modeNum]}**`);
      break;
      
    case "volume":
    case "vol":
      if (!message.member.voice.channel) {
        return message.reply("❌ You need to be in a voice channel to change volume!");
      }
      
      const volume = parseInt(args[0]);
      if (isNaN(volume) || volume < 0 || volume > 100) {
        return message.reply("⚠️ Please provide a valid volume level between 0 and 100!");
      }
      
      // Try to set volume with Lavalink first
      const lavaVolumePlayer = manager.players.get(message.guild.id);
      if (lavaVolumePlayer) {
        lavaVolumePlayer.setVolume(volume);
        globalState.volume = volume;
        message.channel.send(`🔊 Volume set to: **${volume}%** (Lavalink)`);
        break;
      }
      
      // Fall back to DisTube if no Lavalink player
      const volQueue = distube.getQueue(message);
      if (!volQueue) {
        return message.reply("❌ There is nothing playing! (DisTube)");
      }
      
      volQueue.setVolume(volume);
      globalState.volume = volume;
      message.channel.send(`🔊 Volume set to: **${volume}%** (DisTube)`);
      break;
      
    case "nowplaying":
    case "np":
      // Try to get current song from Lavalink first
      const lavaNpPlayer = manager.players.get(message.guild.id);
      if (lavaNpPlayer && lavaNpPlayer.queue.current) {
        const currentTrack = lavaNpPlayer.queue.current;
        
        const npEmbed = new EmbedBuilder()
          .setColor(0x3498DB)
          .setTitle("🎵 Now Playing (Lavalink)")
          .setDescription(`[${currentTrack.title}](${currentTrack.uri})`)
          .setThumbnail(currentTrack.thumbnail || currentTrack.displayThumbnail())
          .addFields(
            { name: "Duration", value: formatLavaDuration(currentTrack.duration), inline: true },
            { name: "Requested By", value: currentTrack.requester.tag, inline: true },
            { name: "Author", value: currentTrack.author || "Unknown", inline: true }
          )
          .setTimestamp();
        
        message.channel.send({ embeds: [npEmbed] });
        break;
      }
      
      // Fall back to DisTube if no Lavalink player
      const npQueue = distube.getQueue(message);
      if (!npQueue) {
        return message.reply("❌ There is nothing playing! (DisTube)");
      }
      
      const song = npQueue.songs[0];
      message.channel.send(
        `🎵 **Now Playing (DisTube)**\n${song.name} - \`${song.formattedDuration}\` - Requested by ${song.user}`
      );
      break;
      
    case "help":
      const helpEmbed = {
        title: "🤖 Bot Commands",
        description: "Here are the available commands:",
        fields: [
          // Music commands
          {
            name: "🎵 Music Commands",
            value: "Control music playback in voice channels",
          },
          {
            name: "!play <song>",
            value: "Play a song from YouTube, Spotify, or a search query (uses Lavalink if available, falls back to DisTube)",
          },
          {
            name: "!play <spotify_url>",
            value: "Play a song from Spotify (supports tracks, albums, playlists) - URLs are automatically formatted",
          },
          {
            name: "!play spotify:<track|album|playlist>:<id>",
            value: "Play Spotify content using the Spotify URI format",
          },
          {
            name: "!lavalink",
            value: "Show Lavalink connection status and statistics",
          },
          {
            name: "!cookies <cookie_string>",
            value: "Update YouTube cookies to fix 'Sign in to confirm you're not a bot' error (fallback method)",
          },
          {
            name: "YouTube API",
            value: "Bot now uses YouTube Data API for enhanced video information and reliability",
          },
          {
            name: "!stop",
            value: "Stop playing and clear the queue",
          },
          {
            name: "!skip",
            value: "Skip to the next song",
          },
          {
            name: "!pause",
            value: "Pause the current song",
          },
          // AI commands
          {
            name: "🧠 AI Commands",
            value: "Interact with the AI assistant",
          },
          {
            name: "!ai <prompt>",
            value: "Ask the AI assistant a question or request help",
          },
          // Leveling commands
          {
            name: "📊 Leveling Commands",
            value: "Check your level and XP",
          },
          {
            name: "!level",
            value: "Check your current level and XP",
          },
          {
            name: "!rank <@user>",
            value: "Check another user's level and XP",
          },
          {
            name: "!leaderboard",
            value: "View the server's XP leaderboard",
          },
          // Welcome message commands
          {
            name: "👋 Welcome Message Commands",
            value: "Configure welcome messages for new members",
          },
          {
            name: "!welcome channel <#channel>",
            value: "Set the channel for welcome messages",
          },
          {
            name: "!welcome message <message>",
            value: "Set the welcome message (use {user}, {username}, {server}, {membercount} as placeholders)",
          },
          {
            name: "!welcome test",
            value: "Test the welcome message",
          },
          {
            name: "!resume",
            value: "Resume the paused song",
          },
          {
            name: "!radio",
            value: "Play 24/7 lofi radio stream",
          },
          {
            name: "!radioindo",
            value: "Play 24/7 Indonesian radio stream",
          },
          {
            name: "!stop",
            value: "Stop the current music or radio",
          },
          {
            name: "!queue",
            value: "Show the current queue",
          },
          {
            name: "!loop [off/song/queue]",
            value: "Set loop mode (off, song, or queue)",
          },
          {
            name: "!volume <0-100>",
            value: "Set the volume level",
          },
          {
            name: "!nowplaying",
            value: "Show the currently playing song",
          },
        ],
        footer: {
          text: "Music Bot powered by DisTube",
        },
      };
      
      message.channel.send({ embeds: [helpEmbed] });
      break;
      
    // AI command
    case "chat":
      if (!args.length) {
        return message.reply("❓ Please provide a prompt for the AI!");
      }
      
      // Show typing indicator while generating response
      message.channel.sendTyping();
      
      try {
        const prompt = args.join(" ");
        const response = await generateAIResponse(prompt);
        
        // Create an embed for the AI response
        const aiEmbed = new EmbedBuilder()
          .setColor(0x3498DB)
          .setTitle('AI Response')
          .setDescription(response)
          .setFooter({ text: 'Powered by OpenRouter AI' })
          .setTimestamp();
        
        message.reply({ embeds: [aiEmbed] });
      } catch (error) {
        console.error("AI command error:", error);
        message.reply("❌ Sorry, I encountered an error while processing your request.");
      }
      break;
      
    case "lavalink":
      try {
        // Get Lavalink nodes status
        const nodes = manager.nodes;
        
        if (nodes.size === 0) {
          return message.reply("❌ No Lavalink nodes are configured.");
        }
        
        // Send a loading message first
        const loadingMsg = await message.channel.send("⏳ Checking Lavalink status...");
        
        // Create the main status embed
        const statusEmbed = new EmbedBuilder()
          .setColor(0x3498DB)
          .setTitle('✅ Lavalink Status')
          .setDescription('Current status of Lavalink music system:')
          .setTimestamp()
          .setFooter({ text: 'Lavalink is a powerful audio sending node' });
        
        // Track overall system health
        let allNodesConnected = true;
        let totalPlayers = 0;
        let totalPlayingPlayers = 0;
        
        // Process each node
        nodes.forEach(node => {
          const isConnected = node.connected;
          if (!isConnected) allNodesConnected = false;
          
          const status = isConnected ? '✅ Connected' : '❌ Disconnected';
          const statusColor = isConnected ? '🟢' : '🔴';
          
          // Format uptime if available
          let uptime = 'Unknown';
          if (node.stats && node.stats.uptime) {
            const uptimeMs = node.stats.uptime;
            const hours = Math.floor(uptimeMs / 3600000);
            const minutes = Math.floor((uptimeMs % 3600000) / 60000);
            uptime = `${hours}h ${minutes}m`;
          }
          
          // Get detailed stats if available
          let cpuLoad = 'N/A';
          let memoryUsage = 'N/A';
          let players = 0;
          let playingPlayers = 0;
          
          if (node.stats) {
            cpuLoad = `${(node.stats.cpu.systemLoad * 100).toFixed(2)}%`;
            memoryUsage = `${(node.stats.memory.used / 1024 / 1024).toFixed(2)} MB`;
            players = node.stats.players;
            playingPlayers = node.stats.playingPlayers;
            
            // Add to totals
            totalPlayers += players;
            totalPlayingPlayers += playingPlayers;
          }
          
          // Add field for this node
          statusEmbed.addFields({
            name: `${statusColor} Node: ${node.options.identifier || 'default'}`,
            value: [
              `**Status:** ${status}`,
              `**Address:** ${node.options.host}:${node.options.port}`,
              `**Uptime:** ${uptime}`,
              `**CPU Load:** ${cpuLoad}`,
              `**Memory:** ${memoryUsage}`,
              `**Players:** ${players} (${playingPlayers} active)`
            ].join('\n')
          });
        });
        
        // Add overall status field
        statusEmbed.addFields({
          name: '📊 Overall Status',
          value: [
            `**System Status:** ${allNodesConnected ? '✅ All systems operational' : '⚠️ Some nodes disconnected'}`,
            `**Total Players:** ${totalPlayers}`,
            `**Active Players:** ${totalPlayingPlayers}`,
            `**Spotify Integration:** ${process.env.SPOTIFY_CLIENT_ID ? '✅ Enabled' : '❌ Disabled'}`,
            `**YouTube Cookies:** ${fs.existsSync('./cookies.txt') ? '✅ Configured' : '⚠️ Not configured'}`
          ].join('\n')
        });
        
        // Update the loading message with the embed
        await loadingMsg.edit({ content: null, embeds: [statusEmbed] });
      } catch (error) {
        console.error("Error checking Lavalink status:", error);
        message.reply("❌ An error occurred while checking Lavalink status: " + error.message);
      }
      break;
      
    // Level command
    case "level":
    case "rank":
      try {
        // Get the target user (mentioned user or command author)
        const targetUser = message.mentions.users.first() || message.author;
        
        // Get user data from database
        const userData = await User.findOne({ 
          userId: targetUser.id, 
          guildId: message.guild.id 
        });
        
        if (!userData) {
          return message.reply(`${targetUser.username} hasn't earned any XP yet!`);
        }
        
        // Calculate progress to next level
        const nextLevelXP = Math.pow((userData.level + 1), 2) * 100;
        const currentXP = userData.xp;
        const progressPercentage = Math.min(100, Math.floor((currentXP / nextLevelXP) * 100));
        
        // Create progress bar
        const progressBarLength = 20;
        const filledBlocks = Math.floor((progressPercentage / 100) * progressBarLength);
        const progressBar = '█'.repeat(filledBlocks) + '░'.repeat(progressBarLength - filledBlocks);
        
        // Create level embed
        const levelEmbed = new EmbedBuilder()
          .setColor(0x3498DB)
          .setTitle(`${targetUser.username}'s Level`)
          .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
          .addFields(
            { name: 'Level', value: `${userData.level}`, inline: true },
            { name: 'XP', value: `${currentXP}/${nextLevelXP}`, inline: true },
            { name: 'Progress', value: `${progressBar} ${progressPercentage}%` }
          )
          .setFooter({ text: `Requested by ${message.author.username}` })
          .setTimestamp();
        
        message.reply({ embeds: [levelEmbed] });
      } catch (error) {
        console.error("Level command error:", error);
        message.reply("❌ An error occurred while fetching level data.");
      }
      break;
      
    case "leaderboard":
    case "lb":
      try {
        // Get top 10 users by XP in the current guild
        const topUsers = await User.find({ guildId: message.guild.id })
          .sort({ xp: -1 })
          .limit(10);
        
        if (topUsers.length === 0) {
          return message.reply("No one has earned XP in this server yet!");
        }
        
        // Create leaderboard entries
        let leaderboardText = "";
        
        for (let i = 0; i < topUsers.length; i++) {
          const user = topUsers[i];
          try {
            // Try to fetch the Discord user
            const discordUser = await client.users.fetch(user.userId);
            const username = discordUser ? discordUser.username : 'Unknown User';
            
            // Add medal emoji for top 3
            let prefix = `${i + 1}.`;
            if (i === 0) prefix = "🥇";
            else if (i === 1) prefix = "🥈";
            else if (i === 2) prefix = "🥉";
            
            leaderboardText += `${prefix} **${username}** - Level: ${user.level} (XP: ${user.xp})\n`;
          } catch (error) {
            console.error(`Error fetching user ${user.userId}:`, error);
            leaderboardText += `${i + 1}. Unknown User - Level: ${user.level} (XP: ${user.xp})\n`;
          }
        }
        
        // Create leaderboard embed
        const leaderboardEmbed = new EmbedBuilder()
          .setColor(0x3498DB)
          .setTitle(`🏆 XP Leaderboard - ${message.guild.name}`)
          .setDescription(leaderboardText)
          .setFooter({ text: `Requested by ${message.author.username}` })
          .setTimestamp();
        
        message.reply({ embeds: [leaderboardEmbed] });
      } catch (error) {
        console.error("Leaderboard command error:", error);
        message.reply("❌ An error occurred while fetching leaderboard data.");
      }
      break;
      
    // AI command
    case "ai":
      try {
        if (!args.length) {
          return message.reply("❌ Please provide a prompt for the AI!");
        }
        
        const prompt = args.join(" ");
        const loadingMessage = await message.channel.send("🤖 Thinking...");
        
        // Call the OpenRouter API
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`
          },
          body: JSON.stringify({
            model: "openai/gpt-3.5-turbo",
            messages: [
              { 
                role: "system", 
                content: "You are a helpful Discord bot assistant. Provide concise, accurate, and friendly responses. Format your responses clearly with spacing between paragraphs for readability." 
              },
              { role: "user", content: prompt }
            ],
            max_tokens: 500
          })
        });
        
        const data = await response.json();
        
        if (data.error) {
          console.error("AI API Error:", data.error);
          await loadingMessage.delete();
          return message.reply(`❌ Error: ${data.error.message || "Unknown error occurred"}`);
        }
        
        const aiResponse = data.choices[0].message.content;
        
        // Create AI response embed
        const aiEmbed = new EmbedBuilder()
          .setColor(0x3498DB)
          .setTitle("🤖 AI Response")
          .setDescription(aiResponse)
          .setFooter({ text: `Requested by ${message.author.username}` })
          .setTimestamp();
        
        await loadingMessage.delete();
        message.reply({ embeds: [aiEmbed] });
      } catch (error) {
        console.error("AI command error:", error);
        message.reply("❌ An error occurred while processing your AI request.");
      }
      break;
      
    // Welcome message configuration
    // Radio commands
    case "radio":
      playRadio(message, "https://lofi.stream.laut.fm/lofi", "Lofi Radio");
      break;
      
    case "radioindo":
      playRadio(message, "https://radione.top:8888/dmi", "Indonesian Radio");
      break;
      
    case "stop":
      // Check if we're playing radio
      if (globalState.radioPlayers.has(message.guild.id)) {
        stopRadio(message);
      } else {
        // If not radio, use DisTube to stop music
        const queue = distube.getQueue(message);
        if (!queue) return message.reply("❌ Nothing is playing!");
        
        try {
          distube.stop(message);
          message.reply("⏹️ Stopped the music!");
        } catch (error) {
          console.error("Stop error:", error);
          message.reply("❌ An error occurred while trying to stop the music.");
        }
      }
      break;
      
    case "welcome":
      // Check if user has admin permissions
      if (!message.member.permissions.has("ADMINISTRATOR")) {
        return message.reply("❌ You need administrator permissions to use this command!");
      }
      
      if (!args.length) {
        return message.reply("❓ Please specify a subcommand: `channel`, `message`, or `test`");
      }
      
      const subCommand = args.shift().toLowerCase();
      
      switch (subCommand) {
        case "channel":
          // Set welcome channel
          const channel = message.mentions.channels.first();
          if (!channel) {
            return message.reply("❓ Please mention a channel: `!welcome channel #welcome`");
          }
          
          try {
            await Guild.findOneAndUpdate(
              { guildId: message.guild.id },
              { welcomeChannelId: channel.id },
              { upsert: true }
            );
            
            message.reply(`✅ Welcome channel set to ${channel}`);
          } catch (error) {
            console.error("Welcome channel error:", error);
            message.reply("❌ An error occurred while setting the welcome channel.");
          }
          break;
          
        case "message":
          // Set welcome message
          if (!args.length) {
            return message.reply("❓ Please provide a welcome message. You can use `{user}`, `{username}`, `{server}`, and `{membercount}` as placeholders.");
          }
          
          const welcomeMessage = args.join(" ");
          
          try {
            await Guild.findOneAndUpdate(
              { guildId: message.guild.id },
              { welcomeMessage },
              { upsert: true }
            );
            
            message.reply(`✅ Welcome message set to: ${welcomeMessage}`);
          } catch (error) {
            console.error("Welcome message error:", error);
            message.reply("❌ An error occurred while setting the welcome message.");
          }
          break;
          
        case "test":
          // Test welcome message
          try {
            const guildSettings = await Guild.findOne({ guildId: message.guild.id });
            
            if (!guildSettings || !guildSettings.welcomeChannelId) {
              return message.reply("❌ Welcome channel not set. Use `!welcome channel #channel` first.");
            }
            
            const welcomeChannel = message.guild.channels.cache.get(guildSettings.welcomeChannelId);
            if (!welcomeChannel) {
              return message.reply("❌ Welcome channel not found. It may have been deleted.");
            }
            
            // Replace placeholders in welcome message
            const testMessage = guildSettings.welcomeMessage
              .replace(/{user}/g, `<@${message.author.id}>`)
              .replace(/{username}/g, message.author.username)
              .replace(/{server}/g, message.guild.name)
              .replace(/{membercount}/g, message.guild.memberCount);
            
            // Create a welcome embed
            const testEmbed = new EmbedBuilder()
              .setColor(0x3498DB)
              .setTitle(`Welcome to ${message.guild.name}!`)
              .setDescription(testMessage)
              .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
              .setFooter({ text: `Member #${message.guild.memberCount}` })
              .setTimestamp();
            
            // Send the test welcome message
            welcomeChannel.send({ embeds: [testEmbed] });
            message.reply(`✅ Test welcome message sent to ${welcomeChannel}`);
          } catch (error) {
            console.error("Welcome test error:", error);
            message.reply("❌ An error occurred while testing the welcome message.");
          }
          break;
          
        default:
          message.reply("❓ Unknown subcommand. Use `channel`, `message`, or `test`.");
      }
      break;
      
    default:
      // Unknown command
      break;
  }
});

// Set up Express server for dashboard
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static files
app.use(express.static(join(__dirname, "public")));

// Serve the dashboard HTML
app.get("/", (req, res) => {
  const dashboardPath = join(__dirname, "public", "dashboard.html");
  
  // Check if dashboard.html exists, if not create it
  if (!fs.existsSync(dashboardPath)) {
    const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Music Bot Dashboard</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background-color: #2c2f33;
            color: #ffffff;
        }
        h1, h2, h3 {
            color: #7289da;
        }
        .container {
            background-color: #23272a;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
        }
        .controls {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            margin-bottom: 20px;
        }
        button {
            background-color: #7289da;
            color: white;
            border: none;
            padding: 10px 15px;
            border-radius: 4px;
            cursor: pointer;
            transition: background-color 0.3s;
        }
        button:hover {
            background-color: #5b6eae;
        }
        button.active {
            background-color: #43b581;
        }
        .queue-list {
            max-height: 300px;
            overflow-y: auto;
            margin-top: 10px;
        }
        .queue-item {
            display: flex;
            justify-content: space-between;
            padding: 8px;
            border-bottom: 1px solid #40444b;
        }
        .badge {
            display: inline-block;
            padding: 3px 8px;
            border-radius: 12px;
            font-size: 0.8em;
        }
        .badge-success {
            background-color: #43b581;
        }
        .badge-warning {
            background-color: #faa61a;
        }
        .badge-info {
            background-color: #7289da;
        }
        .badge-danger {
            background-color: #f04747;
        }
        .volume-control {
            margin-top: 20px;
        }
        #volume-slider {
            width: 100%;
        }
        .status-bar {
            display: flex;
            justify-content: space-between;
            margin-top: 20px;
            padding: 10px;
            background-color: #40444b;
            border-radius: 4px;
        }
        .cookie-form {
            margin-top: 20px;
        }
        .cookie-form textarea {
            width: 100%;
            min-height: 80px;
            margin-bottom: 10px;
            background-color: #40444b;
            color: white;
            border: 1px solid #7289da;
            border-radius: 4px;
            padding: 8px;
        }
    </style>
</head>
<body>
    <h1>Discord Music Bot Dashboard</h1>
    
    <div class="container">
        <div id="status">
            <h2>🔈 Not Playing</h2>
            <p>Use !play command to play music</p>
        </div>
        
        <div class="controls">
            <button onclick="control('pause')">⏸️ Pause</button>
            <button onclick="control('resume')">▶️ Resume</button>
            <button onclick="control('skip')">⏭️ Skip</button>
            <button onclick="control('stop')">⏹️ Stop</button>
        </div>
        
        <div class="volume-control">
            <h3>🔊 Volume</h3>
            <input type="range" id="volume-slider" min="0" max="100" value="50" oninput="setVolume(this.value)">
            <span id="volume-value">50%</span>
        </div>
        
        <div>
            <h3>🔄 Loop Mode</h3>
            <button id="loop-off" onclick="setLoopMode('off')">Off</button>
            <button id="loop-track" onclick="setLoopMode('track')">Track</button>
            <button id="loop-queue" onclick="setLoopMode('queue')">Queue</button>
        </div>
    </div>
    
    <div class="container">
        <h2>📋 Queue</h2>
        <div id="queue-container">
            <h3>Queue is empty</h3>
        </div>
    </div>
    
    <div class="container">
        <h2>⚙️ YouTube Cookies</h2>
        <p>If you're getting "Sign in to confirm you're not a bot" errors, update your YouTube cookies here:</p>
        <div class="cookie-form">
            <textarea id="cookies-input" placeholder="Enter your YouTube cookies here (e.g., VISITOR_INFO1_LIVE=value; CONSENT=value; etc.)"></textarea>
            <button onclick="updateCookies()">Update Cookies</button>
        </div>
        <p><strong>How to get your YouTube cookies:</strong></p>
        <ol>
            <li>Login to YouTube in your browser</li>
            <li>Open Developer Tools (F12 or right-click > Inspect)</li>
            <li>Go to the "Application" or "Storage" tab</li>
            <li>Find "Cookies" > "youtube.com"</li>
            <li>Look for cookies like VISITOR_INFO1_LIVE, CONSENT, etc.</li>
            <li>Copy the name=value pairs and paste them above</li>
        </ol>
    </div>
    
    <div class="container">
        <h2>⚙️ System Status</h2>
        <p>FFmpeg: <span id="ffmpeg-status">Checking...</span></p>
        <p>Connection: <span id="connection-status">Disconnected</span></p>
    </div>
    
    <script>
        const ws = new WebSocket("ws://" + window.location.host);
        let currentGuildId = null;
        
        // Connect to WebSocket
        ws.onopen = function() {
            console.log('Connected to server');
            requestStatus();
        };
        
        ws.onmessage = function(event) {
            try {
                const data = JSON.parse(event.data);
                
                // Store the guild ID for controls
                currentGuildId = data.guildId;
                
                // Update status display
                let statusHtml = '';
                
                if (data.currentTrack) {
                    statusHtml = '<div class="current-song">' +
                        '<h2>🎵 Now Playing</h2>' +
                        '<h3>' + data.currentTrack.title + '</h3>' +
                        '<p>by ' + data.currentTrack.author + ' • ' + data.currentTrack.duration + '</p>' +
                        '<p>' +
                        'Status: ' + (data.isPlaying ? 
                            '<span class="badge badge-success">Playing</span>' : 
                            '<span class="badge badge-warning">Paused</span>') +
                        ' Loop: <span class="badge badge-info">' + data.loopMode.toUpperCase() + '</span>' +
                        ' Connection: ' + (data.voiceConnectionStatus === 'connected' ? 
                            '<span class="badge badge-success">Connected</span>' : 
                            '<span class="badge badge-danger">Disconnected</span>') +
                        '</p>' +
                        '</div>';
                } else {
                    statusHtml = '<div>' +
                        '<h2>🔈 Not Playing</h2>' +
                        '<p>Use !play command to play music</p>' +
                        '</div>';
                }
                
                document.getElementById('status').innerHTML = statusHtml;
                
                // Update queue display
                let queueHtml = '';
                
                if (data.queue && data.queue.length > 0) {
                    queueHtml = '<h3>📋 Queue (' + data.queue.length + ' songs)</h3>' +
                        '<div class="queue-list">';
                    
                    data.queue.forEach((track, index) => {
                        queueHtml = queueHtml + '<div class="queue-item">' +
                            '<div>' + (index + 1) + '. ' + track.title + '</div>' +
                            '<div>' + track.duration + '</div>' +
                            '</div>';
                    });
                    
                    queueHtml = queueHtml + '</div>';
                } else if (data.currentTrack) {
                    queueHtml = '<h3>📋 Queue is empty</h3>';
                }
                
                document.getElementById('queue-container').innerHTML = queueHtml;
                
                // Update loop buttons
                document.getElementById('loop-off').className = data.loopMode === 'off' ? 'active' : '';
                document.getElementById('loop-track').className = data.loopMode === 'track' ? 'active' : '';
                document.getElementById('loop-queue').className = data.loopMode === 'queue' ? 'active' : '';
                
                // Update FFmpeg status
                document.getElementById('ffmpeg-status').textContent = data.ffmpegStatus === 'configured' ? 
                    '✅ Configured' : '❌ Missing';
                
                // Update connection status
                document.getElementById('connection-status').textContent = 
                    data.voiceConnectionStatus === 'connected' ? '✅ Connected' : '❌ Disconnected';
                
            } catch (error) {
                console.error('Status update error:', error);
                document.getElementById('status').innerHTML = '<h2>❌ Error connecting to server</h2>';
            }
        }
        
        async function control(action) {
            if (!currentGuildId) {
                alert('No active music session');
                return;
            }
            
            try {
                const response = await fetch('/control', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        action,
                        guildId: currentGuildId
                    }),
                });
                
                const result = await response.json();
                if (!result.success) {
                    alert("Error: " + result.message);
                }
                
                // Request updated status
                requestStatus();
                
            } catch (error) {
                console.error('Control error:', error);
                alert('Failed to send command to server');
            }
        }
        
        async function setVolume(volume) {
            document.getElementById('volume-value').textContent = volume + "%";
            
            if (!currentGuildId) {
                return;
            }
            
            try {
                const response = await fetch('/volume', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        volume: parseInt(volume),
                        guildId: currentGuildId
                    }),
                });
                
                const result = await response.json();
                if (!result.success) {
                    alert("Error: " + result.message);
                }
                
            } catch (error) {
                console.error('Volume control error:', error);
            }
        }
        
        async function setLoopMode(mode) {
            if (!currentGuildId) {
                alert('No active music session');
                return;
            }
            
            try {
                const response = await fetch('/loop', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        mode,
                        guildId: currentGuildId
                    }),
                });
                
                const result = await response.json();
                if (!result.success) {
                    alert("Error: " + result.message);
                }
                
                // Request updated status
                requestStatus();
                
            } catch (error) {
                console.error('Loop control error:', error);
                alert('Failed to change loop mode');
            }
        }
        
        async function updateCookies() {
            const cookiesInput = document.getElementById('cookies-input').value;
            
            if (!cookiesInput) {
                alert('Please enter your YouTube cookies');
                return;
            }
            
            try {
                const response = await fetch('/update-cookies', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        cookies: cookiesInput
                    }),
                });
                
                const result = await response.json();
                if (result.success) {
                    alert("YouTube cookies updated successfully!");
                    document.getElementById('cookies-input').value = '';
                } else {
                    alert("Error: " + result.message);
                }
                
            } catch (error) {
                console.error('Update cookies error:', error);
                alert('Failed to update YouTube cookies');
            }
        }
        
        function requestStatus() {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'getStatus' }));
            }
        }
        
        // Request status update every 5 seconds
        setInterval(requestStatus, 5000);
    </script>
</body>
</html>
    `;
    
    fs.writeFileSync(dashboardPath, htmlContent);
  }
  
  res.sendFile(dashboardPath);
});

// API endpoints for controlling the bot
app.use(express.json());

// Control endpoint (pause, resume, skip, stop)
app.post("/control", (req, res) => {
  const { action, guildId } = req.body;
  
  if (!guildId) {
    return res.json({ success: false, message: "No guild ID provided" });
  }
  
  const queue = distube.getQueue(guildId);
  if (!queue) {
    return res.json({ success: false, message: "No active queue found" });
  }
  
  try {
    switch (action) {
      case "pause":
        if (queue.paused) {
          return res.json({ success: false, message: "Already paused" });
        }
        queue.pause();
        break;
      case "resume":
        if (!queue.paused) {
          return res.json({ success: false, message: "Already playing" });
        }
        queue.resume();
        break;
      case "skip":
        queue.skip();
        break;
      case "stop":
        queue.stop();
        break;
      default:
        return res.json({ success: false, message: "Invalid action" });
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error(`Control error (${action}):`, error);
    res.json({ success: false, message: error.message });
  }
});

// Volume control endpoint
app.post("/volume", (req, res) => {
  const { volume, guildId } = req.body;
  
  if (!guildId) {
    return res.json({ success: false, message: "No guild ID provided" });
  }
  
  if (typeof volume !== "number" || volume < 0 || volume > 100) {
    return res.json({ success: false, message: "Invalid volume level" });
  }
  
  const queue = distube.getQueue(guildId);
  if (!queue) {
    globalState.volume = volume; // Still update global state
    return res.json({ success: true });
  }
  
  try {
    queue.setVolume(volume);
    globalState.volume = volume;
    res.json({ success: true });
  } catch (error) {
    console.error("Volume control error:", error);
    res.json({ success: false, message: error.message });
  }
});

// Loop mode control endpoint
app.post("/loop", (req, res) => {
  const { mode, guildId } = req.body;
  
  if (!guildId) {
    return res.json({ success: false, message: "No guild ID provided" });
  }
  
  const queue = distube.getQueue(guildId);
  if (!queue) {
    return res.json({ success: false, message: "No active queue found" });
  }
  
  try {
    let modeNum;
    switch (mode) {
      case "off":
        modeNum = 0;
        break;
      case "track":
      case "song":
        modeNum = 1;
        break;
      case "queue":
        modeNum = 2;
        break;
      default:
        return res.json({ success: false, message: "Invalid loop mode" });
    }
    
    queue.setRepeatMode(modeNum);
    globalState.loopMode = mode;
    res.json({ success: true });
  } catch (error) {
    console.error("Loop control error:", error);
    res.json({ success: false, message: error.message });
  }
});

// Update YouTube cookies endpoint
app.post("/update-cookies", (req, res) => {
  const { cookies } = req.body;
  
  if (!cookies) {
    return res.json({ success: false, message: "No cookies provided" });
  }
  
  try {
    const updated = updateYouTubeCookies(cookies);
    if (updated) {
      res.json({ success: true });
    } else {
      res.json({ success: false, message: "Failed to update YouTube cookies" });
    }
  } catch (error) {
    console.error("Update cookies error:", error);
    res.json({ success: false, message: error.message });
  }
});

// WebSocket connection handling
wss.on("connection", (ws) => {
  console.log("Client connected to dashboard");
  
  // Send initial status
  ws.send(JSON.stringify({
    ...globalState,
    timestamp: Date.now(),
  }));
  
  // Handle messages from clients
  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === "getStatus") {
        ws.send(JSON.stringify({
          ...globalState,
          timestamp: Date.now(),
        }));
      }
    } catch (error) {
      console.error("WebSocket message error:", error);
    }
  });
  
  ws.on("close", () => {
    console.log("Client disconnected from dashboard");
  });
});

// Broadcast status updates to all connected clients
function broadcastStatus() {
  if (wss.clients.size > 0) {
    const status = {
      ...globalState,
      timestamp: Date.now(),
    };
    
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(status));
      }
    });
  }
}

// Broadcast status every 3 seconds if clients are connected
setInterval(() => {
  if (wss.clients.size > 0) {
    broadcastStatus();
  }
}, 3000);

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Dashboard running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to view the dashboard`);
});

// Load YouTube cookies from file if available
try {
  if (fs.existsSync('./cookies.txt')) {
    const cookiesContent = fs.readFileSync('./cookies.txt', 'utf8');
    console.log('Loading YouTube cookies from cookies.txt file...');
    updateYouTubeCookies(cookiesContent);
  }
} catch (error) {
  console.error('Error loading YouTube cookies from file:', error);
}

// Login to Discord with your client's token
client.login(process.env.DISCORD_TOKEN);