# Briefcast

<div align="center">
  <img src="files/logo.png" alt="Briefcast Logo" width="200"/>
</div>

## Overview
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/zezhuyu/BriefCast_Pocket)

Briefcast is a cutting-edge lightweight **personalized AI-generated podcast platform** that transforms how you consume audio content. Using advanced AI technologies, Briefcast creates custom podcast episodes tailored to your interests, schedule, and preferences. Whether you're commuting, exercising, or relaxing, get personalized audio content that matters to you.

## ✨ Features

- **🤖 AI-Powered Content Generation**: Advanced language models create engaging, personalized podcast episodes
- **📱 Multi-Platform Support**: Available on Web, iOS, and Desktop (Tauri-based)
- **🎯 Personalization Engine**: Learns from your preferences to deliver relevant content
- **🔊 High-Quality Audio**: Natural text-to-speech with multiple voice options
- **📊 Smart Curation**: Intelligent content sourcing and summarization
- **⚡ Real-time Processing**: Fast content generation and delivery
- **🌐 Web Crawling**: Automated content discovery from trusted sources
- **📈 User Analytics**: Track listening habits and content preferences
- **🔗 RSS Feeds**: Subscribe to your favorite websites and RSS feeds

## 🏗️ Architecture

Briefcast is built as a comprehensive multi-platform ecosystem:

```
├── 📱 ios/          # Native iOS app (Swift/Xcode)
└──  🖥️ desktop/      # macOS desktop app (Electron + Next.js)
```

## 🚀 Quick Start

> This project has been tested on MacOS with Apple Silicon (M1, M2, etc.) 16GB+ RAM and Ubuntu 22.04 LTS 16GB+ RAM with Nvidia GPU.
> 
> You can set LOCAL_AUDIO=False in the backend/.env file to use OpenAI TTS to reduce the RAM usage.

### iOS Development
```bash
cd ios
open BriefCast.xcodeproj
# Build and run in Xcode
```

### Desktop Application (macOS)

The desktop app is built with **Electron + Next.js**. You must run `npm install` in **both** the `desktop/` and `desktop/frontend/` directories before building.

```bash
# Install dependencies in both directories
cd desktop
npm install
cd frontend
npm install
cd ..

# Development mode
npm run dev

# Build and package a macOS app (produces a .dmg)
npm run dist:mac

# Or build just the app bundle without packaging
npm run build
npm run dist:dmg
```

> **Note:** The macOS distributable will be output to `desktop/release/`.
> Make sure you have [Node.js](https://nodejs.org/) and [Electron](https://www.electronjs.org/) installed.

## 📖 Usage

> **Note: For safety reasons, sign up and api token issue feature only available on the desktop app and can only be accessed on the same device.**
>
> mobile app need to get api token from the desktop app.
1. **Sign Up**: Create your account and set your preferences 
2. **Customize**: Choose topics, sources, and content types you're interested in
3. **Generate**: AI creates personalized podcast episodes based on your profile
4. **Listen**: Enjoy your custom content across any of our platforms
5. **Refine**: Rate content to improve future recommendations

## 📱 Platform Availability

- ✅ **Web Browser**: Access via any modern browser
- ✅ **iOS**: Native app for iPhone and iPad
- ✅ **Desktop**: Cross-platform app for Windows, macOS, and Linux

## 📝 Screenshots

### 🖥️ macOS Desktop App

<div align="center">

**Library View**
<img src="files/macos_library.png" alt="macOS Library" width="800"/>

**Audio Player**
<img src="files/macos_player.png" alt="macOS Player" width="800"/>

</div>

### 📱 iOS Mobile App

<div align="center">
  
<img src="files/ios_library.png" alt="iOS Library" width="250"/> <img src="files/ios_player.png" alt="iOS Player" width="250"/> <img src="files/ios_history.png" alt="iOS History" width="250"/>

**Library View** &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; **Audio Player** &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; **History**

</div>

## 🛡️ Privacy & Security

- End-to-end encryption for user data
- GDPR compliant data handling
- No third-party tracking
- Local processing options available

## 📄 License

This project is licensed under the terms specified in the [LICENSE](LICENSE) file.


## 🤝 Contributing

We welcome contributions!


## 🖥️ TypeScript Desktop Rewrite

A pure TypeScript desktop rewrite is available under [`desktop-ts/`](desktop-ts).

```bash
cd desktop-ts
npm install
npm run dev
```

This rewrite also starts a local compatibility API bridge (REST/GraphQL/MCP) so existing API-based tooling can still connect.
