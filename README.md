# NetX

A beautiful, single-file desktop application that shares internet access between two machines using only a **shared folder** (network drive, USB sync, Syncthing, etc.).

No complex networking setup. The built-in **Portable Browser** handles HTTP and HTTPS traffic seamlessly right out of the box, with full support for video streaming and real-time WebSockets.

## Features
- **One unified App**: Toggle between Server and Client modes instantly.
- **Bidirectional Streaming Protocol**: The revolutionary new engine chunks all network requests into tiny `.dat` files, enabling infinite video streaming and real-time two-way WebSocket connections over any filesystem. 
- **Launch Real Browser**: The Offline Client automatically launches an isolated **Google Chrome** instance. No need to install dangerous Root CAs into your operating system, and no need to configure your system-wide proxy settings.
- **Full HTTPS Support**: Built-in TLS MITM proxy perfectly inspects, tunnels, and encrypts HTTPS.
- **Cross-Platform**: Runs on Windows, macOS, and Linux.
- **Auto-Cleanup & Logging**: The Server and Client automatically purge zombie `.dat` and `.json` files when starting, and clear the UI logs to keep your session pristine.

---

## How It Works

```
Machine A (internet)          Shared Folder          Machine B (no internet)
┌──────────────────┐         ┌────────────┐         ┌────────────────────────┐
│  NetX Desktop    │◄────────│req_1.json  │◄────────│   NetX Desktop         │
│  [Server Mode]   │────────►│ack_1.json  │────────►│   [Client Mode]        │
│                  │         │            │         │                        │
│   (TLS Tunnel)   │◄────────│req_1_0.dat │◄────────│   (wss:// Upgrade)     │
│                  │────────►│res_1_0.dat │────────►│                        │
└──────────────────┘         └────────────┘         └──────────▲─────────────┘
                                                               │  (Proxy :8080)
                                                    ┌──────────┴─────────────┐
                                                    │ Real Google Chrome     │
                                                    └────────────────────────┘
```
The **Client** stands up a local HTTP/HTTPS proxy. It connects to the web browser and converts TCP socket streams into sequential `.dat` chunks written to a shared folder. The **Server** reads them, streams the data to the real internet, and streams the incoming results back into `.dat` chunks. 

When you start the offline machine's proxy, NetX seamlessly spawns an isolated Chrome window configured to use this proxy and trust the local HTTPS certificates.

---

## Installation 

### Option 1 (Compile from Source)
Make sure NodeJS is installed.
```bash
git clone https://github.com/nos486/netx.git
cd netx
npm install
npm start         # Run app locally
```

### Option 2 (Build Executables)
NetX uses Electron Forge to compile standalone apps for any operating system.

**Mac / Linux / Windows**
Simply run the package command from the OS you want to target:
```bash
npm run package -- --platform=win32 --arch=x64
```
The compiled Application (e.g., `<app>.dmg`, `<app>.exe`, `<app>.zip`, `<app>.deb`) will be generated inside the `/out/` folder. Copy that file onto a USB and put it on your offline machine.

*Note: You must run `package` on a Windows machine to build the `.exe`, and on a Mac to build the macOS releases.*

---

## Usage Guide

### 1. Set up a Shared Folder
Both machines must be able to read/write to the same folder rapidly. Options:
- **Syncthing** (highly recommended for near-instant low latency WebSockets and Video Streaming)
- **Windows network share / SMB**
- **USB drive** mounted on both machines.

### 2. Start the Server (The machine with Internet)
1. Open NetX.
2. Click **Server (Internet)** mode.
3. Click **Browse** and select your shared folder.
4. Click **Start Proxy**.
   *(It will display a live log of connections being established and will automatically sweep dead files)*

### 3. Start the Client (The Offline machine)
1. Open NetX.
2. Click **Client (Offline)** mode.
3. Select the **SAME** shared folder.
4. Click **Start Proxy**.

**That's it!** A Google Chrome browser will automatically launch. 

Type any URL (like `https://youtube.com` or `wss://echo.websocket.org`) into the address bar and hit Enter. The page will load perfectly with no blocking certificate warnings!
